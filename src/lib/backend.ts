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
