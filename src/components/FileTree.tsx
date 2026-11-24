import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TreeNode } from "../lib/backend";
import { isOpenable } from "../panes/open";

interface Props {
  nodes: TreeNode[];
  activePath: string | null;
  /** The folder new files are added to ("" = workspace root). */
  targetDir: string;
  /** Recently added or moved files: highlighted, and their folders expanded. */
  added: string[];
  /** Folder currently under a drag ("" = root), or null when not dragging. */
  dropTarget: string | null;
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
  onDropTargetChange: (dir: string | null) => void;
  /** A file was dragged onto a folder. */
  onMove: (path: string, destDir: string) => void;
  onContextMenu: (path: string, x: number, y: number) => void;
}

const parentDir = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The folder under a point: the nearest element marked with data-drop-dir. */
export function dropDirAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]");
  return el ? (el.dataset.dropDir ?? null) : null;
}

const DRAG_THRESHOLD = 5;

export function FileTree({ nodes, dropTarget, onDropTargetChange, onMove, ...rest }: Props) {
  // A file being dragged inside the tree (pointer events, so it works the
  // same on every platform and doesn't clash with drops from the OS).
  const drag = useRef<{ path: string; x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [ghost, setGhost] = useState<{ name: string; x: number; y: number } | null>(null);

  function startDrag(e: ReactPointerEvent, path: string) {
    suppressClick.current = false;
    if (e.button !== 0) return;
    drag.current = { path, x: e.clientX, y: e.clientY, active: false };
  }

  useEffect(() => {
    function move(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
      d.active = true;
      setGhost({ name: d.path.split("/").pop() ?? d.path, x: e.clientX, y: e.clientY });
      const dir = dropDirAt(e.clientX, e.clientY);
      onDropTargetChange(dir !== null && dir !== parentDir(d.path) ? dir : null);
    }
    function up(e: PointerEvent) {
      const d = drag.current;
      drag.current = null;
      if (!d?.active) return;
      suppressClick.current = true; // the click that ends a drag isn't an "open"
      setGhost(null);
      onDropTargetChange(null);
      const dir = dropDirAt(e.clientX, e.clientY);
      if (dir !== null && dir !== parentDir(d.path)) onMove(d.path, dir);
    }
    function cancel(e: KeyboardEvent) {
      if (e.key === "Escape" && drag.current?.active) {
        drag.current = null;
        setGhost(null);
        onDropTargetChange(null);
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", cancel);
    };
  }, [onDropTargetChange, onMove]);

  return (
    <>
      <ul className={`tree${dropTarget === "" ? " drop-target" : ""}`} role="tree" data-drop-dir="">
        {nodes.map((n) => (
          <TreeItem
            key={n.path}
            node={n}
            depth={0}
            dropTarget={dropTarget}
            startDrag={startDrag}
            suppressClick={suppressClick}
            {...rest}
          />
        ))}
      </ul>
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x + 12, top: ghost.y + 8 }}>
          {ghost.name}
        </div>
      )}
    </>
  );
}

type ItemProps = { node: TreeNode; depth: number } & Pick<
  Props,
  "activePath" | "targetDir" | "added" | "dropTarget" | "onOpen" | "onSelectDir" | "onContextMenu"
> & {
    startDrag: (e: ReactPointerEvent, path: string) => void;
    suppressClick: React.MutableRefObject<boolean>;
  };

function TreeItem(props: ItemProps) {
  const { node, depth, activePath, targetDir, added, dropTarget, onOpen, onSelectDir, onContextMenu, startDrag, suppressClick } =
    props;
  const [expanded, setExpanded] = useState(depth === 0);
  const indent = { paddingLeft: 8 + depth * 14 };

  // Open folders that contain newly added or moved files.
  useEffect(() => {
    if (node.kind === "dir" && added.some((p) => p.startsWith(`${node.path}/`))) setExpanded(true);
  }, [added, node]);

  // Hovering a collapsed folder during a drag opens it, so you can go deeper.
  useEffect(() => {
    if (node.kind !== "dir" || dropTarget !== node.path || expanded) return;
    const t = window.setTimeout(() => setExpanded(true), 700);
    return () => window.clearTimeout(t);
  }, [dropTarget, node, expanded]);

  if (node.kind === "dir") {
    const isTarget = node.path === targetDir;
    const classes = ["tree-row"];
    if (isTarget) classes.push("target");
    if (dropTarget === node.path) classes.push("drop-target");
    return (
      <li role="treeitem" aria-expanded={expanded} aria-selected={isTarget} data-drop-dir={node.path}>
        <button
          className={classes.join(" ")}
          style={indent}
          title={`${node.path}/ (new files are added to the selected folder)`}
          onClick={() => {
            // Clicking a folder selects it as the destination for added files;
            // clicking the selected folder again folds or unfolds it.
            if (isTarget || !expanded) setExpanded(!expanded);
            onSelectDir(node.path);
          }}
        >
          <span className="tree-caret">{expanded ? "▾" : "▸"}</span>
          {node.name}
        </button>
        {expanded && (
          <ul role="group">
            {node.children.map((c) => (
              <TreeItem key={c.path} {...props} node={c} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const openable = isOpenable(node.path);
  const classes = ["tree-row", "file"];
  if (node.path === activePath) classes.push("active");
  if (added.includes(node.path)) classes.push("added");
  if (!openable) classes.push("unopenable");
  return (
    // Dropping onto a file drops into the file's folder.
    <li role="treeitem" data-drop-dir={parentDir(node.path)}>
      <button
        className={classes.join(" ")}
        style={indent}
        title={openable ? node.path : `${node.path} (this file type can't be opened yet)`}
        onPointerDown={(e) => startDrag(e, node.path)}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (openable) onOpen(node.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(node.path, e.clientX, e.clientY);
        }}
      >
        <span className="tree-caret" />
        {node.name}
      </button>
    </li>
  );
}
