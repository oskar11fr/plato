import { describe, expect, it } from "vitest";
import { buildGraph } from "./graph";
import { indexFiles } from "./wikilinks";

const pages = [
  { path: "wiki/index.md", text: "# Wiki\n\n- [[wiki/sources/a|A]]\n- [[wiki/concepts/lstm]]" },
  { path: "wiki/log.md", text: "# Log\n\n- [[wiki/sources/a]]" },
  {
    path: "wiki/sources/a.md",
    text: '---\ntype: "source-summary"\ntitle: "Paper A"\nsource: "[[papers/a.pdf]]"\n---\n# Paper A\n\nUses [[lstm]] and [[LSTM|again]], cites [[papers/a.pdf#page=2|p. 2]], mentions [[self-attention]] and [[gone/page]].',
  },
  { path: "wiki/concepts/lstm.md", text: "# LSTM\n\nSee [[wiki/sources/a]] and [[self-attention]]." },
  {
    path: "wiki/sources/b/00-overview.md",
    text: '---\ntype: "source-summary"\nkind: "book"\ntitle: "Book B"\n---\n# Book B\n\n1. [[wiki/sources/b/01-one|One]]',
  },
  { path: "wiki/sources/b/01-one.md", text: '---\ntype: "source-section"\ntitle: "One"\nbook: "[[wiki/sources/b/00-overview]]"\n---\n# One' },
  { path: "wiki/notes.md", text: "# Notes\n\nNothing linked." },
];
const files = indexFiles([...pages.map((p) => p.path), "papers/a.pdf"]);

describe("wiki graph", () => {
  it("has a node per page, typed, and an edge per linked pair", () => {
    const { nodes, links } = buildGraph(pages, files, { missing: false });
    expect(nodes.map((n) => [n.id, n.kind, n.title, n.degree])).toEqual([
      ["wiki/sources/a.md", "source", "Paper A", 1],
      ["wiki/concepts/lstm.md", "concept", "LSTM", 1],
      ["wiki/sources/b/00-overview.md", "book", "Book B", 1],
      ["wiki/sources/b/01-one.md", "book", "One", 1],
      ["wiki/notes.md", "other", "Notes", 0],
    ]);
    // a ↔ lstm once (linked both ways, twice from a), overview ↔ chapter once; no PDF, index or log edges.
    expect(links).toEqual([
      { source: "wiki/sources/a.md", target: "wiki/concepts/lstm.md" },
      { source: "wiki/sources/b/00-overview.md", target: "wiki/sources/b/01-one.md" },
    ]);
  });

  it("can show pages linked but not written yet", () => {
    const { nodes, links } = buildGraph(pages, files, { missing: true });
    const missing = nodes.filter((n) => n.kind === "missing");
    expect(missing).toEqual([
      { id: "missing:self-attention", title: "self-attention", kind: "missing", path: "wiki/concepts/self-attention.md", degree: 2 },
    ]);
    expect(links.filter((l) => l.target === "missing:self-attention")).toHaveLength(2);
  });
});
