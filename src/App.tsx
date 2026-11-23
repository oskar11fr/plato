import { open } from "@tauri-apps/plugin-dialog";
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileTree } from "./components/FileTree";
import {
  LAYOUT_FILE,
  listTree,
  openWorkspace,
  readTextFileOpt,
  writeTextFile,
  type TreeNode,
  type WorkspaceInfo,
} from "./lib/backend";
import { openFile, paneComponents } from "./panes";
import "./App.css";

const LAST_WORKSPACE_KEY = "plato.lastWorkspace";
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
      // File panes carry `path`; a chat pane highlights its document.
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

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="workspace-name" title={workspace?.root}>
            {workspace?.name ?? "No folder open"}
          </span>
          {workspace && (
            <button className="icon-button" title="Refresh files" onClick={refreshTree}>
              ↻
            </button>
          )}
          <button className="icon-button" title="Open folder" onClick={chooseFolder}>
            ⊕
          </button>
        </header>
        {error && <div className="sidebar-error">{error}</div>}
        {workspace ? (
          <FileTree nodes={tree} activePath={activePath} onOpen={(p) => api && openFile(api, p)} />
        ) : (
          <div className="sidebar-empty">
            <button onClick={chooseFolder}>Open folder…</button>
          </div>
        )}
      </aside>
      <main className="dock">
        <DockviewReact components={paneComponents} onReady={onReady} theme={themeAbyss} />
      </main>
    </div>
  );
}
