import { useState } from "react";
import type { TreeNode } from "../lib/backend";
import { isOpenable } from "../panes/open";

interface Props {
  nodes: TreeNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function FileTree({ nodes, activePath, onOpen }: Props) {
  return (
    <ul className="tree" role="tree">
      {nodes.map((n) => (
        <TreeItem key={n.path} node={n} depth={0} activePath={activePath} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  depth,
  activePath,
  onOpen,
}: { node: TreeNode; depth: number } & Omit<Props, "nodes">) {
  const [expanded, setExpanded] = useState(depth === 0);
  const indent = { paddingLeft: 8 + depth * 14 };

  if (node.kind === "dir") {
    return (
      <li role="treeitem" aria-expanded={expanded}>
        <button className="tree-row" style={indent} onClick={() => setExpanded(!expanded)}>
          <span className="tree-caret">{expanded ? "▾" : "▸"}</span>
          {node.name}
        </button>
        {expanded && (
          <ul role="group">
            {node.children.map((c) => (
              <TreeItem
                key={c.path}
                node={c}
                depth={depth + 1}
                activePath={activePath}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const openable = isOpenable(node.path);
  return (
    <li role="treeitem">
      <button
        className={`tree-row file${node.path === activePath ? " active" : ""}`}
        style={indent}
        disabled={!openable}
        onClick={() => onOpen(node.path)}
      >
        <span className="tree-caret" />
        {node.name}
      </button>
    </li>
  );
}
