// Typed wrappers over the Rust commands. Panes call these, never the disk.
import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceInfo {
  root: string;
  name: string;
}

export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

export const READER_DIR = ".reader";
export const LAYOUT_FILE = `${READER_DIR}/workspace.json`;

export const openWorkspace = (path: string) =>
  invoke<WorkspaceInfo>("open_workspace", { path });

export const listTree = () => invoke<TreeNode[]>("list_tree");

export const readTextFile = (path: string) =>
  invoke<string>("read_text_file", { path });

export const readBinaryFile = (path: string) =>
  invoke<ArrayBuffer>("read_binary_file", { path });

export const readTextFileOpt = (path: string) =>
  invoke<string | null>("read_text_file_opt", { path });

export const writeTextFile = (path: string, contents: string) =>
  invoke<void>("write_text_file", { path, contents });

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

/** Entries of one workspace folder; a missing folder lists as empty. */
export const listDir = (path: string) => invoke<DirEntry[]>("list_dir", { path });

/** Delete a file under `.reader/` (the backend refuses anything else). */
export const deleteAppFile = (path: string) => invoke<void>("delete_app_file", { path });

/** Pick files on the computer and copy them into a workspace folder ("" = root).
 *  Returns the added workspace paths; empty if the picker was cancelled. */
export const importFiles = (destDir: string) => invoke<string[]>("import_files", { destDir });

/** Copy files dropped from the OS (only paths from that drop are accepted). */
export const importDropped = (paths: string[], destDir: string) =>
  invoke<string[]>("import_dropped", { paths, destDir });

/** Move a file to another folder; its highlights and chats move along. Returns the new path. */
export const moveFile = (path: string, destDir: string) => invoke<string>("move_file", { path, destDir });

/** Move a file to the system Trash (its highlights and chats are kept). */
export const trashFile = (path: string) => invoke<void>("trash_file", { path });
