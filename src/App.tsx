import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dropDirAt, FileTree } from "./components/FileTree";
import { FolderIcon, PlusIcon, RefreshIcon, SettingsIcon } from "./components/Icons";
import { flushAnnotationSaves } from "./lib/annotations";
import {
  importDropped,
  importFiles,
  moveFile,
  trashFile,
  LAYOUT_FILE,
  listTree,
  openWorkspace,
  readTextFileOpt,
  writeTextFile,
  type TreeNode,
  type WorkspaceInfo,
} from "./lib/backend";
import { filesChanged } from "./lib/bus";
import { isOpenable, openChat, openFile, openSettings, openSummary, paneComponents, type ChatParams } from "./panes";
import "./App.css";

const LAST_WORKSPACE_KEY = "plato.lastWorkspace";

// dockview's light theme, recoloured from the app's tokens in App.css.
const dockTheme: DockviewTheme = { name: "plato", className: "dockview-theme-light plato-dock" };
const LAYOUT_VERSION = 1;

// Per-device convenience only; the app works without it.
function rememberWorkspace(path: string | null) {
  try {
    if (path) localStorage.setItem(LAST_WORKSPACE_KEY, path);
    else localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {}
}
function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export default function App() {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where "Add files" copies to ("" = workspace root), and what it just added.
  const [targetDir, setTargetDir] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimer = useRef<number | undefined>(undefined);
  // Folder under a drag (from the tree or from Finder), and the file menu.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  // Layout saves are suppressed while a workspace is loading, so a pending
  // save from the previous workspace never lands in the new one.
  const saveTimer = useRef<number | undefined>(undefined);
  const loading = useRef(false);

  const loadWorkspace = useCallback(async (dvApi: DockviewApi, path: string) => {
    loading.current = true;
    window.clearTimeout(saveTimer.current);
    setError(null);
    try {
      const info = await openWorkspace(path);
      setWorkspace(info);
      setTargetDir("");
      setAdded([]);
      setTree(await listTree());
      rememberWorkspace(info.root);

      dvApi.clear();
      const saved = await readTextFileOpt(LAYOUT_FILE);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.version === LAYOUT_VERSION) dvApi.fromJSON(parsed.layout);
        } catch (e) {
          console.warn("Ignoring unreadable layout file", e);
          dvApi.clear();
        }
      }
    } catch (e) {
      setError(String(e));
      rememberWorkspace(null);
    } finally {
      loading.current = false;
    }
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      setApi(event.api);
      const last = lastWorkspace();
      if (last) loadWorkspace(event.api, last);
    },
    [loadWorkspace],
  );

  // Save the layout to .reader/workspace.json whenever it changes.
  useEffect(() => {
    if (!api || !workspace) return;
    const layoutSub = api.onDidLayoutChange(() => {
      if (loading.current) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        const contents = JSON.stringify({ version: LAYOUT_VERSION, layout: api.toJSON() }, null, 2);
        writeTextFile(LAYOUT_FILE, contents).catch((e) => console.error("Saving layout failed", e));
      }, 500);
    });
    const activeSub = api.onDidActivePanelChange(({ panel }) => {
      // File panes carry `path`; chat and summary panes highlight their document.
      const params = panel?.params as { path?: string; docPath?: string } | undefined;
      setActivePath(params?.path ?? params?.docPath ?? null);
    });
    return () => {
      layoutSub.dispose();
      activeSub.dispose();
    };
  }, [api, workspace]);

  async function chooseFolder() {
    if (!api) return;
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") await loadWorkspace(api, picked);
  }

  async function refreshTree() {
    try {
      setTree(await listTree());
    } catch (e) {
      setError(String(e));
    }
  }

  function openPath(path: string) {
    if (!api) return;
    openFile(api, path);
    // New files go next to the file being read.
    setTargetDir(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  }

  /** Show a status line and highlight files in the tree for a few seconds. */
  function announce(message: string, paths: string[] = []) {
    setAdded(paths);
    setStatus(message);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => {
      setAdded([]);
      setStatus(null);
    }, 4000);
  }

  const where = (dir: string) => (dir ? `${dir}/` : "the workspace");
  const nameOf = (path: string) => path.split("/").pop() ?? path;

  async function afterImport(paths: string[], dir: string) {
    if (paths.length === 0) return; // picker cancelled
    await refreshTree();
    announce(`Added ${paths.length === 1 ? nameOf(paths[0]) : `${paths.length} files`} to ${where(dir)}`, paths);
    // A single readable file opens right away.
    if (paths.length === 1 && isOpenable(paths[0])) openPath(paths[0]);
  }

  async function addFiles() {
    setError(null);
    try {
      await afterImport(await importFiles(targetDir), targetDir);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Close a file's panes before it moves or goes to the Trash, so nothing
   *  writes to its old location. Returns what was open, to reopen it. */
  async function closePanesFor(path: string) {
    const filePanel = api?.getPanel(`file:${path}`);
    const chatPanel = api?.getPanel(`chat:${path}`);
    const summaryPanel = api?.getPanel(`summary:${path}`);
    const chatPath = (chatPanel?.params as ChatParams | undefined)?.chatPath;
    filePanel?.api.close();
    chatPanel?.api.close();
    summaryPanel?.api.close();
    await flushAnnotationSaves();
    return { file: !!filePanel, chat: !!chatPanel, summary: !!summaryPanel, chatPath };
  }

  const moveTo = useCallback(
    async (path: string, destDir: string) => {
      if (!api) return;
      setError(null);
      const open = await closePanesFor(path);
      try {
        const moved = await moveFile(path, destDir);
        await refreshTree();
        announce(`Moved ${nameOf(path)} to ${where(destDir)}`, [moved]);
        if (open.file) openPath(moved);
        if (open.chat) {
          // The document's chat folder moved along with it.
          const chatPath = open.chatPath?.replace(`chats/${path}/`, `chats/${moved}/`);
          openChat(api, moved, chatPath);
        }
        if (open.summary) openSummary(api, moved);
      } catch (e) {
        setError(String(e));
        if (open.file) openPath(path); // nothing moved; restore the panes
        if (open.summary) openSummary(api, path);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read current state
    [api],
  );

  async function moveToTrash(path: string) {
    setMenu(null);
    const ok = await ask(
      `Move "${nameOf(path)}" to the Trash?\n\nYou can restore it from the Trash. Its highlights and chats are kept and come back with it.`,
      { title: "Move to Trash", kind: "warning", okLabel: "Move to Trash", cancelLabel: "Cancel" },
    ).catch(() => false);
    if (!ok) return;
    setError(null);
    await closePanesFor(path);
    try {
      await trashFile(path);
      await refreshTree();
      announce(`Moved ${nameOf(path)} to the Trash`);
    } catch (e) {
      setError(String(e));
    }
  }

  // Files dragged in from Finder: highlight the folder under the pointer,
  // copy them there on drop. (Only available in the desktop app.)
  useEffect(() => {
    if (!workspace) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const dirAt = (p: { x: number; y: number }) => dropDirAt(p.x / window.devicePixelRatio, p.y / window.devicePixelRatio);
    try {
      getCurrentWebview()
        .onDragDropEvent(async ({ payload }) => {
          if (payload.type === "enter" || payload.type === "over") {
            setDropTarget(dirAt(payload.position));
          } else if (payload.type === "drop") {
            setDropTarget(null);
            const dir = dirAt(payload.position);
            if (dir === null) {
              announce("Drop files onto a folder in the sidebar to add them.");
              return;
            }
            try {
              await afterImport(await importDropped(payload.paths, dir), dir);
            } catch (e) {
              setError(String(e));
            }
          } else {
            setDropTarget(null);
          }
        })
        .then((un) => (disposed ? un() : (unlisten = un)), () => {});
    } catch {
      // Not running inside Tauri (e.g. a plain browser): no OS drops.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read current state
  }, [workspace]);

  // Panes that write files (e.g. a saved wiki page) show up in the tree.
  useEffect(() => {
    if (!workspace) return;
    return filesChanged.subscribe(() => void refreshTree());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshTree reads current state
  }, [workspace]);

  // Close the file menu on any outside click, scroll or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && (e.target as Element).closest?.(".context-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("wheel", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="workspace-name" title={workspace?.root}>
            {workspace?.name ?? "No folder open"}
          </span>
          {workspace && (
            <button className="icon-button" title="Refresh files" aria-label="Refresh files" onClick={refreshTree}>
              <RefreshIcon />
            </button>
          )}
          <button className="icon-button" title="Open folder" aria-label="Open folder" onClick={chooseFolder}>
            <FolderIcon />
          </button>
          <button className="icon-button" title="Settings" aria-label="Settings" onClick={() => api && openSettings(api)}>
            <SettingsIcon />
          </button>
        </header>
        {error && <div className="sidebar-error">{error}</div>}
        {workspace ? (
          <>
            <FileTree
              nodes={tree}
              activePath={activePath}
              targetDir={targetDir}
              added={added}
              dropTarget={dropTarget}
              onOpen={openPath}
              onSelectDir={setTargetDir}
              onDropTargetChange={setDropTarget}
              onMove={moveTo}
              onContextMenu={(path, x, y) => setMenu({ path, x, y })}
            />
            <footer className="sidebar-footer">
              {status && <div className="sidebar-status">{status}</div>}
              <button className="add-files" onClick={addFiles} title="Copy files from your computer into this folder">
                <PlusIcon /> Add files
                <span className="add-files-target">to {targetDir ? `${targetDir}/` : "workspace root"}</span>
              </button>
              {targetDir && (
                <button className="link-button" onClick={() => setTargetDir("")}>
                  Use workspace root
                </button>
              )}
            </footer>
          </>
        ) : (
          <div className="sidebar-empty">
            <button onClick={chooseFolder}>Open folder…</button>
          </div>
        )}
      </aside>
      {menu && workspace && (
        <div className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          <div className="context-menu-title">{nameOf(menu.path)}</div>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              revealItemInDir(`${workspace.root}/${menu.path}`).catch((e) => setError(String(e)));
            }}
          >
            Show in Finder
          </button>
          <button role="menuitem" className="danger" onClick={() => void moveToTrash(menu.path)}>
            Move to Trash…
          </button>
        </div>
      )}
      <main className="dock">
        <DockviewReact components={paneComponents} onReady={onReady} theme={dockTheme} />
      </main>
    </div>
  );
}
