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
}

impl Workspace {
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
        Workspace { root: Mutex::new(Some(PathBuf::from(root))) }
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
    fn resolve_requires_open_workspace() {
        assert!(Workspace::default().resolve("a.md").is_err());
    }
}
