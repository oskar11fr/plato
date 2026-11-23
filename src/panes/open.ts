import type { DockviewApi } from "dockview-react";

export interface FileParams {
  path: string;
}
export interface ChatParams {
  docPath: string;
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

/** Open the document's single ongoing chat beside it. */
export function openChat(api: DockviewApi, docPath: string) {
  const id = `chat:${docPath}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const docPanel = api.getPanel(`file:${docPath}`);
  api.addPanel<ChatParams>({
    id,
    component: "chat",
    title: `Chat · ${basename(docPath)}`,
    params: { docPath },
    position: docPanel ? { referencePanel: docPanel, direction: "right" } : undefined,
  });
}
