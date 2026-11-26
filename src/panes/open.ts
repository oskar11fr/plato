import type { DockviewApi } from "dockview-react";
import { revealHighlight, showChat } from "../lib/bus";
import { resolveWikiLink } from "../lib/wikilinks";

export interface FileParams {
  path: string;
}
export interface ChatParams {
  docPath: string;
  /** The chat file shown in the pane; omitted for a new, unsaved chat. */
  chatPath?: string;
}

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "text"]);

function componentFor(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return null;
}

export const isOpenable = (path: string) => componentFor(path) !== null;

const basename = (path: string) => path.split("/").pop() ?? path;

/** Open a file in a pane, or focus it if it is already open. */
export function openFile(api: DockviewApi, path: string) {
  const id = `file:${path}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const component = componentFor(path);
  if (!component) return;
  api.addPanel<FileParams>({ id, component, title: basename(path), params: { path } });
}

/** Open the document's chat pane beside it (optionally on a given chat). */
export function openChat(api: DockviewApi, docPath: string, chatPath?: string) {
  const id = `chat:${docPath}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    if (chatPath) showChat.emit(docPath, chatPath);
    return;
  }
  const docPanel = api.getPanel(`file:${docPath}`);
  api.addPanel<ChatParams>({
    id,
    component: "chat",
    title: `Chat · ${basename(docPath)}`,
    params: chatPath ? { docPath, chatPath } : { docPath },
    position: docPanel ? { referencePanel: docPanel, direction: "right" } : undefined,
  });
}

export interface SummaryParams {
  docPath: string;
}

/** Open the document's summary pane beside it. */
export function openSummary(api: DockviewApi, docPath: string) {
  const id = `summary:${docPath}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const docPanel = api.getPanel(`file:${docPath}`);
  api.addPanel<SummaryParams>({
    id,
    component: "summary",
    title: `Summary · ${basename(docPath)}`,
    params: { docPath },
    position: docPanel ? { referencePanel: docPanel, direction: "right" } : undefined,
  });
}

/** Follow a [[wiki link]]: open the file, at the cited page for a PDF. */
export function openWikiLink(api: DockviewApi, target: string) {
  const { path, page } = resolveWikiLink(target);
  if (!componentFor(path)) return;
  openFile(api, path);
  if (page) revealHighlight.emit(path, { page });
}

/** Open (or focus) the connection settings pane. */
export function openSettings(api: DockviewApi) {
  const existing = api.getPanel("settings");
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({ id: "settings", component: "settings", title: "Settings" });
}

/** Open (or focus) the wiki lint pane. */
export function openLint(api: DockviewApi) {
  const existing = api.getPanel("lint");
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({ id: "lint", component: "lint", title: "Lint wiki" });
}
