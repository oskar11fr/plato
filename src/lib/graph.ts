// The wiki as a graph: a node per page, an edge per pair of pages that link
// to each other (either way), and optionally a node per page that's linked
// but not written yet.
import { parseFrontMatter, str } from "./frontmatter";
import { LOG_FILE, type WikiPage } from "./lint";
import { CONCEPTS_DIR, INDEX_FILE } from "./summary";
import { findWikiLinks, linkCandidates, resolveWikiLink, type FileIndex } from "./wikilinks";

/** What a node is, which sets its color: one-page summaries, books (overview and chapters), concept pages, other pages, pages still to write. */
export type NodeKind = "source" | "book" | "concept" | "other" | "missing";

export interface GraphNode {
  id: string;
  title: string;
  kind: NodeKind;
  /** The page to open (for a missing page, where it would be). */
  path: string;
  /** How many other nodes it's linked with. */
  degree: number;
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface WikiGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

const isPathLike = (target: string) => target.includes("/") || /\.[a-z0-9]{1,6}$/i.test(target);

function kindOf(page: WikiPage, front: Record<string, unknown>): NodeKind {
  const type = str(front.type);
  if (type === "source-section" || str(front.kind) === "book") return "book";
  if (type === "source-summary") return "source";
  if (type === "concept" || page.path.startsWith(`${CONCEPTS_DIR}/`)) return "concept";
  return "other";
}

export function buildGraph(pages: WikiPage[], index: FileIndex, options: { missing: boolean }): WikiGraph {
  const nodes = new Map<string, GraphNode>();
  const content = pages.filter((p) => p.path !== INDEX_FILE && p.path !== LOG_FILE);
  for (const page of content) {
    const { front, body } = parseFrontMatter(page.text);
    const title = str(front.title) || body.match(/^# (.+)$/m)?.[1].trim() || (page.path.split("/").pop() ?? page.path).replace(/\.md$/, "");
    nodes.set(page.path, { id: page.path, title, kind: kindOf(page, front), path: page.path, degree: 0 });
  }

  const pairs = new Set<string>();
  const links: GraphLink[] = [];
  const connect = (a: string, b: string) => {
    if (a === b) return;
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    if (pairs.has(key)) return;
    pairs.add(key);
    links.push({ source: a, target: b });
    nodes.get(a)!.degree++;
    nodes.get(b)!.degree++;
  };

  for (const page of content) {
    for (const link of findWikiLinks(page.text)) {
      const name = link.target.split("#")[0].trim();
      if (!name) continue;
      const found = linkCandidates(name, index)[0];
      if (found) {
        if (nodes.has(found)) connect(page.path, found);
        continue; // a document or a file outside the wiki
      }
      if (!options.missing || isPathLike(name)) continue;
      const id = `missing:${name.toLowerCase()}`;
      if (!nodes.has(id)) nodes.set(id, { id, title: name, kind: "missing", path: resolveWikiLink(name, index).path, degree: 0 });
      connect(page.path, id);
    }
  }
  return { nodes: [...nodes.values()], links };
}

/** Nodes in the order their legend lists them. */
export const NODE_KINDS: { kind: NodeKind; label: string }[] = [
  { kind: "source", label: "Summaries" },
  { kind: "book", label: "Books" },
  { kind: "concept", label: "Concepts" },
  { kind: "other", label: "Other pages" },
  { kind: "missing", label: "Not written yet" },
];
