// [[wiki links]], as in Obsidian: [[target]], [[target|label]] and
// [[target#page=3|p. 3]]. A target is resolved the way Obsidian does it: a
// workspace path ("papers/a.pdf", "wiki/sources/a"), else a file name found
// anywhere in the workspace ("self-attention" → wiki/concepts/self-attention.md,
// "a.pdf" → papers/a.pdf), preferring wiki/ and then the shortest path. A bare
// name with no page yet points at the concept page it would become.
import { CONCEPTS_DIR, WIKI_DIR } from "./summary";
import { codeRanges, outsideCode } from "./math";

export const WIKILINK_SCHEME = "wikilink:";

const WIKILINK = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g;

/** Turn wiki links into Markdown links with a `wikilink:` URL (code is left alone). */
export function linkifyWikiLinks(markdown: string): string {
  return outsideCode(markdown, (text) =>
    text.replace(WIKILINK, (_, target: string, label?: string) => {
      const shown = (label ?? defaultLabel(target)).replace(/[[\]]/g, "");
      return `[${shown}](${WIKILINK_SCHEME}${encodeURIComponent(target.trim())})`;
    }),
  );
}

function defaultLabel(target: string): string {
  const { path, page } = resolveWikiLink(target);
  const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
  return page ? `${name}, p. ${page}` : target.includes("/") ? name : target.trim();
}

// ---------------------------------------------------------------- the workspace's files

/** Every file in the workspace, by lower-case file name. */
let byName = new Map<string, string[]>();
let fileSet = new Set<string>();

/** Tell link resolution which files exist (the app calls this whenever the file tree changes). */
export function setWorkspaceFiles(paths: string[]) {
  ({ byName, fileSet } = indexFiles(paths));
}

export function indexFiles(paths: string[]) {
  const names = new Map<string, string[]>();
  for (const p of paths) {
    const key = (p.split("/").pop() ?? p).toLowerCase();
    names.set(key, [...(names.get(key) ?? []), p]);
  }
  return { byName: names, fileSet: new Set(paths) };
}

export type FileIndex = ReturnType<typeof indexFiles>;

/** The workspace's files as last set by the app. */
export const currentFileIndex = (): FileIndex => ({ byName, fileSet });

const hasExtension = (name: string) => /\.[a-z0-9]{1,6}$/i.test(name);

/** Prefer pages in the wiki, then the shortest path, then alphabetical. */
const rank = (a: string, b: string) => {
  const wiki = (p: string) => (p.startsWith(`${WIKI_DIR}/`) ? 0 : 1);
  return wiki(a) - wiki(b) || a.split("/").length - b.split("/").length || a.localeCompare(b);
};

/** The files a link target could mean, best first (empty if none exists). */
export function linkCandidates(target: string, index: FileIndex = { byName, fileSet }): string[] {
  const name = target.trim().split("#", 1)[0].trim().replace(/^\/+/, "");
  if (!name) return [];
  const file = hasExtension(name) ? name : `${name}.md`;
  if (index.fileSet.has(file)) return [file];
  const base = (file.split("/").pop() ?? file).toLowerCase();
  const suffix = `/${file.toLowerCase()}`;
  const matches = (index.byName.get(base) ?? []).filter((p) => !file.includes("/") || `/${p.toLowerCase()}`.endsWith(suffix));
  return [...matches].sort(rank);
}

/** Where a link points: a workspace file, and a page for PDF citations. */
export function resolveWikiLink(target: string, index?: FileIndex): { path: string; page?: number } {
  const [rawPath, fragment = ""] = target.trim().split("#", 2);
  const name = rawPath.trim();
  const page = Number(fragment.match(/^page=(\d+)/)?.[1]) || undefined;
  const found = linkCandidates(name, index)[0];
  const path = found ?? (hasExtension(name) ? name : name.includes("/") ? `${name}.md` : `${CONCEPTS_DIR}/${name}.md`);
  return page ? { path, page } : { path };
}

/**
 * The shortest link that finds `path` unambiguously, as Obsidian writes it:
 * the bare file name (without .md) when no other file shares it, else the
 * whole path.
 */
export function linkTarget(path: string, index: FileIndex = { byName, fileSet }): string {
  const file = path.split("/").pop() ?? path;
  const short = file.replace(/\.md$/, "");
  const shared = (index.byName.get(file.toLowerCase()) ?? []).length > 1;
  return shared ? path.replace(/\.md$/, "") : short;
}

export interface FoundLink {
  target: string;
  label?: string;
  /** Position and length of the whole `[[…]]` in the text. */
  index: number;
  length: number;
}

/** The wiki links in some Markdown (not those in code), in order. */
export function findWikiLinks(markdown: string): FoundLink[] {
  const code = codeRanges(markdown);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  return [...markdown.matchAll(WIKILINK)]
    .filter((m) => !inCode(m.index))
    .map((m) => ({ target: m[1].trim(), label: m[2]?.trim(), index: m.index, length: m[0].length }));
}
