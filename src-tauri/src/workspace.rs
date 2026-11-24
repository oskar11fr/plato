//! Workspace file access. The web view never touches the disk directly: every
//! read and write goes through these commands, and every path is relative to
//! the open workspace folder.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct Workspace {
    root: Mutex<Option<PathBuf>>,
    /// Paths in the most recent drag-and-drop from the OS; `import_dropped`
    /// only copies these, so the web view can't name arbitrary files.
    dropped: Mutex<Vec<PathBuf>>,
}

impl Workspace {
    pub fn remember_drop(&self, paths: Vec<PathBuf>) {
        *self.dropped.lock().unwrap() = paths;
    }

    /// A workspace folder files may be added or moved to ("" = root).
    fn dest_dir(&self, dest_dir: &str) -> Result<PathBuf, String> {
        if is_app_path(dest_dir) || dest_dir == READER_DIR {
            return Err("Files can't be put in the app's own folder".into());
        }
        let dest = if dest_dir.is_empty() { self.root()? } else { self.resolve(dest_dir)? };
        if !dest.is_dir() {
            return Err(format!("{dest_dir}: not a folder"));
        }
        Ok(dest)
    }

    fn root(&self) -> Result<PathBuf, String> {
        self.root
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no workspace is open".to_string())
    }

    /// Resolve a workspace-relative path, rejecting absolute paths and `..`.
    fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        let p = Path::new(rel);
        if rel.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(format!("invalid workspace path: {rel:?}"));
        }
        Ok(self.root()?.join(p))
    }
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    root: String,
    name: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TreeNode {
    Dir {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
    File {
        name: String,
        path: String,
    },
}

#[tauri::command]
pub fn open_workspace(path: String, ws: State<Workspace>) -> Result<WorkspaceInfo, String> {
    let root = fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let info = WorkspaceInfo {
        root: root.to_string_lossy().into_owned(),
        name,
    };
    *ws.root.lock().unwrap() = Some(root);
    Ok(info)
}

#[tauri::command]
pub fn list_tree(ws: State<Workspace>) -> Result<Vec<TreeNode>, String> {
    let root = ws.root()?;
    walk(&root, &root).map_err(|e| e.to_string())
}

fn walk(root: &Path, dir: &Path) -> std::io::Result<Vec<TreeNode>> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // Hidden entries (.reader, .git, ...) and dependency folders stay out of the tree.
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let abs = entry.path();
        let rel = rel_path(root, &abs);
        if entry.file_type()?.is_dir() {
            let children = walk(root, &abs)?;
            dirs.push(TreeNode::Dir { name, path: rel, children });
        } else {
            files.push(TreeNode::File { name, path: rel });
        }
    }
    let key = |n: &TreeNode| match n {
        TreeNode::Dir { name, .. } | TreeNode::File { name, .. } => name.to_lowercase(),
    };
    dirs.sort_by_key(key);
    files.sort_by_key(key);
    dirs.extend(files);
    Ok(dirs)
}

/// Workspace-relative path with `/` separators on every platform.
fn rel_path(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[tauri::command]
pub fn read_text_file(path: String, ws: State<Workspace>) -> Result<String, String> {
    let abs = ws.resolve(&path)?;
    fs::read_to_string(&abs).map_err(|e| format!("{path}: {e}"))
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    is_dir: bool,
}

/// The entries of one folder (hidden ones included); a missing folder is empty.
#[tauri::command]
pub fn list_dir(path: String, ws: State<Workspace>) -> Result<Vec<DirEntry>, String> {
    let abs = ws.resolve(&path)?;
    let entries = match fs::read_dir(&abs) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{path}: {e}")),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("{path}: {e}"))?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry { name: entry.file_name().to_string_lossy().into_owned(), is_dir });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Delete a file the app manages. Only paths inside `.reader/` are allowed,
/// so the user's own papers and notes can never be deleted from here.
#[tauri::command]
pub fn delete_app_file(path: String, ws: State<Workspace>) -> Result<(), String> {
    if !is_app_path(&path) {
        return Err(format!("refusing to delete {path:?}: only files in {READER_DIR}/ can be deleted"));
    }
    let abs = ws.resolve(&path)?;
    match fs::remove_file(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

/// Let the user pick files on their computer and copy them into a workspace
/// folder (`dest_dir`, "" for the root). The picker runs here, not in the web
/// view, so only files the user chose can be copied. Existing files are never
/// overwritten: a name that is taken gets a " (2)" suffix. Returns the new
/// workspace-relative paths (empty if the user cancelled).
#[tauri::command]
pub async fn import_files(
    dest_dir: String,
    app: tauri::AppHandle,
    ws: State<'_, Workspace>,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let root = ws.root()?;
    let dest = ws.dest_dir(&dest_dir)?;

    let title = if dest_dir.is_empty() { "Add files to the workspace".to_string() } else { format!("Add files to {dest_dir}") };
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title(title).blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(Vec::new()) };
    let sources: Vec<PathBuf> = picked.into_iter().filter_map(|f| f.into_path().ok()).collect();

    copy_into(&root, &dest, &sources).map_err(|e| e.to_string())
}

/// Copy files into `dest` (inside `root`) without overwriting anything.
fn copy_into(root: &Path, dest: &Path, sources: &[PathBuf]) -> std::io::Result<Vec<String>> {
    let mut added = Vec::new();
    for src in sources {
        if !src.is_file() {
            continue;
        }
        let Some(name) = src.file_name() else { continue };
        let target = unique_path(root, dest, Path::new(name));
        fs::copy(src, &target)?;
        added.push(rel_path(root, &target));
    }
    Ok(added)
}

/// `dir/name`, or `dir/stem (2).ext`, `dir/stem (3).ext`, … if taken. A name
/// also counts as taken when app data (highlights, chats) still exists for it,
/// e.g. from a file moved to the Trash, so a new file never inherits it.
fn unique_path(root: &Path, dir: &Path, name: &Path) -> PathBuf {
    let taken = |p: &Path| {
        let rel = rel_path(root, p);
        p.exists() || annotations_file(root, &rel).exists() || chats_dir(root, &rel).exists()
    };
    let candidate = dir.join(name);
    if !taken(&candidate) {
        return candidate;
    }
    let stem = name.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = name.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !taken(p))
        .expect("some name is free")
}

// App data kept per document, keyed by its workspace path.
fn annotations_file(root: &Path, rel: &str) -> PathBuf {
    root.join(READER_DIR).join("annotations").join(format!("{rel}.json"))
}
fn chats_dir(root: &Path, rel: &str) -> PathBuf {
    root.join(READER_DIR).join("chats").join(rel)
}

/// Copy files dropped onto the app (from Finder) into a workspace folder.
/// Only paths from the latest OS drop are accepted.
#[tauri::command]
pub fn import_dropped(paths: Vec<String>, dest_dir: String, ws: State<Workspace>) -> Result<Vec<String>, String> {
    let root = ws.root()?;
    let dest = ws.dest_dir(&dest_dir)?;
    let dropped = ws.dropped.lock().unwrap().clone();
    let sources: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| dropped.contains(p)).collect();
    if sources.is_empty() {
        return Err("Nothing to add: those files weren't dropped onto Plato.".into());
    }
    copy_into(&root, &dest, &sources).map_err(|e| e.to_string())
}

/// Move a file to another workspace folder. Its highlights and chats move
/// with it, and the chats' links to it are updated. Returns the new path.
#[tauri::command]
pub fn move_file(path: String, dest_dir: String, ws: State<Workspace>) -> Result<String, String> {
    if is_app_path(&path) {
        return Err("App files can't be moved".into());
    }
    let root = ws.root()?;
    let src = ws.resolve(&path)?;
    let dest = ws.dest_dir(&dest_dir)?;
    move_within(&root, &src, &dest).map_err(|e| format!("{path}: {e}"))
}

fn move_within(root: &Path, src: &Path, dest: &Path) -> std::io::Result<String> {
    use std::io::{Error, ErrorKind};
    if !src.is_file() {
        return Err(Error::new(ErrorKind::InvalidInput, "only files can be moved"));
    }
    let old_rel = rel_path(root, src);
    if src.parent() == Some(dest) {
        return Ok(old_rel); // already there
    }
    let name = src.file_name().ok_or_else(|| Error::new(ErrorKind::InvalidInput, "no file name"))?;
    let target = unique_path(root, dest, Path::new(name));
    fs::rename(src, &target)?;
    let new_rel = rel_path(root, &target);

    // Bring the document's app data along.
    let (old_ann, new_ann) = (annotations_file(root, &old_rel), annotations_file(root, &new_rel));
    if old_ann.is_file() {
        fs::create_dir_all(new_ann.parent().expect("has parent"))?;
        fs::rename(&old_ann, &new_ann)?;
    }
    let (old_chats, new_chats) = (chats_dir(root, &old_rel), chats_dir(root, &new_rel));
    if old_chats.is_dir() {
        fs::create_dir_all(new_chats.parent().expect("has parent"))?;
        fs::rename(&old_chats, &new_chats)?;
        for entry in fs::read_dir(&new_chats)? {
            let p = entry?.path();
            if p.extension().is_some_and(|e| e == "md") {
                let text = fs::read_to_string(&p)?;
                let updated = retarget_chat(&text, &old_rel, &new_rel);
                if updated != text {
                    fs::write(&p, updated)?;
                }
            }
        }
    }
    Ok(new_rel)
}

/// Point a chat file at a document's new path: the `source:` front matter
/// line and `[[old]]` / `[[old#…]]` / `[[old|…]]` links. Everything else,
/// including the user's own edits, is left as it is.
fn retarget_chat(text: &str, old: &str, new: &str) -> String {
    let json = |s: &str| serde_json::to_string(s).expect("string serializes");
    let source_old = format!("source: {}", json(old));
    let source_new = format!("source: {}", json(new));
    let mut out: String = text
        .split_inclusive('\n')
        .map(|line| {
            if line.trim_end() == source_old {
                line.replacen(&source_old, &source_new, 1)
            } else {
                line.to_string()
            }
        })
        .collect();
    for suffix in ["]]", "#", "|"] {
        out = out.replace(&format!("[[{old}{suffix}"), &format!("[[{new}{suffix}"));
    }
    out
}

/// Move a file to the system Trash (it can be restored from there). Its
/// highlights and chats stay in `.reader/`, so they reattach if it comes back.
#[tauri::command]
pub fn trash_file(path: String, ws: State<Workspace>) -> Result<(), String> {
    if is_app_path(&path) || path == READER_DIR {
        return Err("App files can't be deleted from here".into());
    }
    let abs = ws.resolve(&path)?;
    if !abs.is_file() {
        return Err(format!("{path}: not a file"));
    }
    #[allow(unused_mut)]
    let mut trash = trash::TrashContext::new();
    #[cfg(target_os = "macos")]
    {
        // Finder's method would ask for permission to control Finder.
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        trash.set_delete_method(DeleteMethod::NsFileManager);
    }
    trash.delete(&abs).map_err(|e| format!("{path}: {e}"))
}

const READER_DIR: &str = ".reader";

fn is_app_path(rel: &str) -> bool {
    let mut parts = Path::new(rel).components();
    matches!(parts.next(), Some(Component::Normal(first)) if first == READER_DIR) && parts.next().is_some()
}

/// Raw bytes (for PDFs), sent as a binary IPC response rather than JSON.
#[tauri::command]
pub fn read_binary_file(path: String, ws: State<Workspace>) -> Result<tauri::ipc::Response, String> {
    let abs = ws.resolve(&path)?;
    let bytes = fs::read(&abs).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Returns `None` when the file does not exist, for optional files such as
/// `.reader/workspace.json`.
#[tauri::command]
pub fn read_text_file_opt(path: String, ws: State<Workspace>) -> Result<Option<String>, String> {
    let abs = ws.resolve(&path)?;
    match fs::read_to_string(&abs) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String, ws: State<Workspace>) -> Result<(), String> {
    let abs = ws.resolve(&path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
    }
    // Write to a temp file and rename, so a crash never leaves a half-written file.
    let tmp = abs.with_extension("tmp-write");
    fs::write(&tmp, contents).map_err(|e| format!("{path}: {e}"))?;
    fs::rename(&tmp, &abs).map_err(|e| format!("{path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws_at(root: &str) -> Workspace {
        Workspace { root: Mutex::new(Some(PathBuf::from(root))), dropped: Mutex::default() }
    }

    #[test]
    fn resolve_accepts_relative_paths() {
        let ws = ws_at("/w");
        assert_eq!(ws.resolve("papers/a.pdf").unwrap(), PathBuf::from("/w/papers/a.pdf"));
        assert_eq!(ws.resolve(".reader/workspace.json").unwrap(), PathBuf::from("/w/.reader/workspace.json"));
    }

    #[test]
    fn resolve_rejects_escapes() {
        let ws = ws_at("/w");
        for bad in ["", "/etc/passwd", "../x", "papers/../../x", "./a"] {
            assert!(ws.resolve(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn import_copies_without_overwriting() {
        let base = std::env::temp_dir().join(format!("plato-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (root, outside) = (base.join("ws"), base.join("downloads"));
        fs::create_dir_all(root.join("papers")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("papers/paper.pdf"), b"old").unwrap();
        fs::write(outside.join("paper.pdf"), b"new").unwrap();
        fs::write(outside.join("notes"), b"no extension").unwrap();

        let sources = vec![outside.join("paper.pdf"), outside.join("notes"), outside.join("missing.pdf"), outside.clone()];
        let added = copy_into(&root, &root.join("papers"), &sources).unwrap();
        assert_eq!(added, vec!["papers/paper (2).pdf", "papers/notes"]);
        assert_eq!(fs::read(root.join("papers/paper.pdf")).unwrap(), b"old", "existing file untouched");
        assert_eq!(fs::read(root.join("papers/paper (2).pdf")).unwrap(), b"new");

        // A third copy takes the next free number.
        let again = copy_into(&root, &root.join("papers"), &[outside.join("paper.pdf")]).unwrap();
        assert_eq!(again, vec!["papers/paper (3).pdf"]);
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("plato-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn move_brings_highlights_and_chats_along() {
        let root = temp_root("move");
        fs::create_dir_all(root.join("inbox")).unwrap();
        fs::create_dir_all(root.join("papers")).unwrap();
        fs::write(root.join("inbox/a.pdf"), b"pdf").unwrap();
        fs::create_dir_all(root.join(".reader/annotations/inbox")).unwrap();
        fs::write(root.join(".reader/annotations/inbox/a.pdf.json"), "{}").unwrap();
        let chats = root.join(".reader/chats/inbox/a.pdf");
        fs::create_dir_all(&chats).unwrap();
        let chat = "---\ntype: \"chat\"\nsource: \"inbox/a.pdf\"\n---\n\nChat about [[inbox/a.pdf]].\n\n\
                    > quote\n> — [[inbox/a.pdf#page=2|a.pdf, p. 2]]\n\nMy note mentions inbox/a.pdf in prose.\n";
        fs::write(chats.join("2026-11-24-x.md"), chat).unwrap();

        let new = move_within(&root, &root.join("inbox/a.pdf"), &root.join("papers")).unwrap();
        assert_eq!(new, "papers/a.pdf");
        assert!(root.join("papers/a.pdf").is_file() && !root.join("inbox/a.pdf").exists());
        assert!(root.join(".reader/annotations/papers/a.pdf.json").is_file());
        assert!(!root.join(".reader/annotations/inbox/a.pdf.json").exists());
        let moved = fs::read_to_string(root.join(".reader/chats/papers/a.pdf/2026-11-24-x.md")).unwrap();
        assert!(moved.contains("source: \"papers/a.pdf\"\n"));
        assert!(moved.contains("[[papers/a.pdf]]") && moved.contains("[[papers/a.pdf#page=2|a.pdf, p. 2]]"));
        assert!(moved.contains("My note mentions inbox/a.pdf in prose."), "prose is left alone");

        // Moving into the folder it is already in changes nothing.
        assert_eq!(move_within(&root, &root.join("papers/a.pdf"), &root.join("papers")).unwrap(), "papers/a.pdf");
    }

    #[test]
    fn names_with_leftover_app_data_count_as_taken() {
        let root = temp_root("taken");
        fs::create_dir_all(root.join(".reader/chats/b.pdf")).unwrap(); // a trashed b.pdf's chats
        fs::write(root.join("x.pdf"), b"x").unwrap();
        let target = unique_path(&root, &root, Path::new("b.pdf"));
        assert_eq!(target, root.join("b (2).pdf"));
        assert_eq!(unique_path(&root, &root, Path::new("c.pdf")), root.join("c.pdf"));
    }

    #[test]
    fn only_app_files_can_be_deleted() {
        assert!(is_app_path(".reader/chats/papers/a.pdf/2026-11-23-x.md"));
        assert!(!is_app_path(".reader"));
        assert!(!is_app_path("papers/a.pdf"));
        assert!(!is_app_path("notes/.reader/x.md"));
    }

    #[test]
    fn resolve_requires_open_workspace() {
        assert!(Workspace::default().resolve("a.md").is_err());
    }
}
