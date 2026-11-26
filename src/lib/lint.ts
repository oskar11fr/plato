// Linting the wiki: checks that need no model (broken and ambiguous links,
// missing pages, orphans, the index, thin pages), and links the model
// suggests between pages.
//
// The model never rewrites a page. It names a phrase that's already in the
// page and the page it should link to; the app finds the phrase itself
// (outside front matter, headings, code, math, tables and existing links),
// shows it for review, and wraps it in a [[link]] if the reader ticks it.
//
// .reader/lint.json remembers which pages were checked against which pages,
// so a later lint only sends pages that changed, and unchanged pages only
// for links to pages added since.
import { parseFrontMatter, str, strList } from "./frontmatter";
import { codeRanges } from "./math";
import { INDEX_FILE, WIKI_DIR } from "./summary";
import { findWikiLinks, linkCandidates, linkTarget, type FileIndex, type FoundLink } from "./wikilinks";

export const LOG_FILE = `${WIKI_DIR}/log.md`;
/** Pages with fewer words than this are reported as thin. */
const THIN_WORDS = 120;
/** At most this many new links per page. */
const MAX_LINKS = 15;

export interface WikiPage {
  path: string;
  text: string;
}

export interface CatalogEntry {
  path: string;
  /** How to link it: the bare name, or the path when the name is shared. */
  link: string;
  title: string;
  aliases: string[];
  type: string;
  summary: string;
}

/** Pages the app maintains as lists; they aren't linked or counted as linking. */
const isListPage = (path: string) => path === INDEX_FILE || path === LOG_FILE;
/** A book's overview is rewritten from its draft whenever a chapter is saved, so links added to it wouldn't last. */
const isRewritten = (path: string) => /\/00-overview\.md$/.test(path);
/** Pages the model is asked to add links to. */
export const isLinkable = (path: string) => !isListPage(path) && !isRewritten(path);

function bodyOf(text: string): string {
  return parseFrontMatter(text).body;
}

/** The page's first paragraph of prose, for the catalog. */
function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^(#|>|<!--|\||```|\$\$|[-*] |\d+\. )/.test(t)) continue;
    return t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\s+/g, " ");
  }
  return "";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Every wiki page a link can point to. */
export function catalogOf(pages: WikiPage[], index: FileIndex): CatalogEntry[] {
  return pages
    .filter((p) => !isListPage(p.path))
    .map((p) => {
      const { front, body } = parseFrontMatter(p.text);
      const title = str(front.title) || body.match(/^# (.+)$/m)?.[1].trim() || (p.path.split("/").pop() ?? p.path).replace(/\.md$/, "");
      const folder = p.path.split("/").slice(-2, -1)[0] ?? "";
      return {
        path: p.path,
        link: linkTarget(p.path, index),
        title,
        aliases: strList(front.aliases),
        type: str(front.type) || folder,
        summary: clip(str(front.tldr) || firstParagraph(body), 220),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------- checks

export interface LintReport {
  /** Links to a path or file that doesn't exist (e.g. a moved or deleted document). */
  broken: { page: string; target: string }[];
  /** Pages linked by name that don't exist yet: stubs to write. */
  missing: { target: string; pages: string[] }[];
  /** Links whose name matches more than one file. */
  ambiguous: { page: string; target: string; candidates: string[] }[];
  /** Pages no other page links to. */
  orphans: string[];
  /** Source pages missing from wiki/index.md, and index links to pages that don't exist. */
  index: { notListed: string[]; listedMissing: string[] };
  thin: { path: string; words: number }[];
}

const isPathLike = (target: string) => target.includes("/") || /\.[a-z0-9]{1,6}$/i.test(target.split("#")[0]);
const words = (body: string) =>
  body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export function runChecks(pages: WikiPage[], index: FileIndex): LintReport {
  const report: LintReport = { broken: [], missing: [], ambiguous: [], orphans: [], index: { notListed: [], listedMissing: [] }, thin: [] };
  const inbound = new Map<string, Set<string>>();
  const missing = new Map<string, Set<string>>();

  for (const page of pages) {
    if (isListPage(page.path)) continue; // the index is checked on its own below
    const seen = new Set<string>();
    for (const link of findWikiLinks(page.text)) {
      const key = link.target.split("#")[0].trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const candidates = linkCandidates(key, index);
      if (candidates.length === 0) {
        if (isPathLike(key)) report.broken.push({ page: page.path, target: key });
        else missing.set(key, (missing.get(key) ?? new Set()).add(page.path));
        continue;
      }
      if (candidates.length > 1 && !isPathLike(key)) report.ambiguous.push({ page: page.path, target: key, candidates });
      if (candidates[0] !== page.path) {
        inbound.set(candidates[0], (inbound.get(candidates[0]) ?? new Set()).add(page.path));
      }
    }
  }
  report.missing = [...missing]
    .map(([target, from]) => ({ target, pages: [...from].sort() }))
    .sort((a, b) => b.pages.length - a.pages.length || a.target.localeCompare(b.target));

  const content = pages.filter((p) => !isListPage(p.path));
  report.orphans = content.filter((p) => !inbound.has(p.path)).map((p) => p.path);
  report.thin = content
    .map((p) => ({ path: p.path, words: words(bodyOf(p.text)) }))
    .filter((p) => p.words < THIN_WORDS)
    .sort((a, b) => a.words - b.words);

  // The index should list every source page (one-page summaries and books' overviews).
  const indexPage = pages.find((p) => p.path === INDEX_FILE);
  const listed = new Set<string>();
  for (const link of indexPage ? findWikiLinks(indexPage.text) : []) {
    const found = linkCandidates(link.target, index)[0];
    if (found) listed.add(found);
    else report.index.listedMissing.push(link.target);
  }
  report.index.notListed = content
    .filter((p) => str(parseFrontMatter(p.text).front.type) === "source-summary" && !listed.has(p.path))
    .map((p) => p.path);
  return report;
}

export const problemCount = (r: LintReport) =>
  r.broken.length + r.ambiguous.length + r.index.notListed.length + r.index.listedMissing.length;

// ---------------------------------------------------------------- which pages to send

export interface LintState {
  version: 1;
  /** The catalog (page paths) at each run that pages were checked against. */
  runs: string[][];
  pages: Record<string, { digest: string; run: number }>;
}

export const emptyLintState = (): LintState => ({ version: 1, runs: [], pages: {} });

export interface PlannedPage {
  path: string;
  /** The pages to suggest links to: all of them, or only those added since the page was last checked. */
  targets: CatalogEntry[];
  reason: "new" | "changed" | "new pages" | "again";
}

/** The pages to send to the model, each with the pages it may link to. */
export function lintPlan(
  pages: (WikiPage & { digest: string })[],
  catalog: CatalogEntry[],
  state: LintState,
  all = false,
): PlannedPage[] {
  const plan: PlannedPage[] = [];
  for (const page of pages) {
    if (!isLinkable(page.path)) continue;
    const others = catalog.filter((c) => c.path !== page.path);
    if (others.length === 0) continue;
    const seen = state.pages[page.path];
    const known = seen ? state.runs[seen.run] : undefined;
    if (!seen || !known) plan.push({ path: page.path, targets: others, reason: "new" });
    else if (seen.digest !== page.digest) plan.push({ path: page.path, targets: others, reason: "changed" });
    else if (all) plan.push({ path: page.path, targets: others, reason: "again" });
    else {
      const added = others.filter((c) => !known.includes(c.path));
      if (added.length) plan.push({ path: page.path, targets: added, reason: "new pages" });
    }
  }
  return plan;
}

/** Remember that pages were checked against the current catalog (`digests` are their texts after any edits). */
export function recordChecked(state: LintState, catalog: CatalogEntry[], digests: Record<string, string>): LintState {
  const paths = catalog.map((c) => c.path);
  const last = state.runs[state.runs.length - 1];
  const same = last && last.length === paths.length && last.every((p, i) => p === paths[i]);
  const runs = same ? state.runs : [...state.runs, paths];
  const pages = { ...state.pages };
  for (const [path, digest] of Object.entries(digests)) pages[path] = { digest, run: runs.length - 1 };
  // Drop runs no page refers to any more.
  const used = [...new Set(Object.values(pages).map((p) => p.run))].sort((a, b) => a - b);
  const renumber = new Map(used.map((r, i) => [r, i]));
  return {
    version: 1,
    runs: used.map((r) => runs[r]),
    pages: Object.fromEntries(Object.entries(pages).map(([p, v]) => [p, { ...v, run: renumber.get(v.run)! }])),
  };
}

// ---------------------------------------------------------------- the model

export function linkSystemPrompt(): string {
  return [
    "You maintain the links of a personal research wiki: Markdown pages that link to each other with [[wiki links]].",
    "You're given one page and a catalog of other pages. Find the places in the page where a reader would want to jump to one of those pages, and say which phrase to link. You don't rewrite the page: the app adds the links.",
    "",
    "Reply with JSON only, in exactly this shape (no code fence, no other text):",
    '{"links": [{"text": "<phrase exactly as written in the page>", "target": "<link from the catalog>", "reason": "<a few words>"}], "fixes": [{"link": "<a link target the page already has>", "target": "<link from the catalog>"}]}',
    "",
    "Links:",
    "- `text` must appear in the page word for word (same case and spelling), in ordinary prose: not in a heading, table, code, math or an existing link.",
    "- Use the most specific phrase that names the page's subject, e.g. the concept, method, model or work itself, not a generic word near it. Aliases in the catalog are other names for the page.",
    "- Link a target once, at its first mention that matters. Don't link the page to itself or to a page it already links to.",
    "- Only link where the other page really is about what the phrase means. When unsure, leave it out: fewer, right links are better than many.",
    `- At most ${MAX_LINKS} links.`,
    "",
    "Fixes:",
    "- The page's links that lead nowhere are listed. If a catalog page is clearly what one of them means (e.g. [[self attention]] for the page linked as self-attention), give it as a fix. Otherwise leave it: it's a page still to be written.",
    "",
    `If there's nothing to add, reply {"links": [], "fixes": []}.`,
  ].join("\n");
}

function catalogLines(entries: CatalogEntry[]): string[] {
  return entries.map((c) => {
    const aliases = c.aliases.length ? ` (also: ${c.aliases.join(", ")})` : "";
    return `- ${c.link} | ${c.type} | ${c.title}${aliases}${c.summary ? `: ${c.summary}` : ""}`;
  });
}

/** The request for one page: the catalog, the page's dead links, then the page. */
export function linkRequestMessage(page: WikiPage, targets: CatalogEntry[], dead: string[], onlyNew: boolean): string {
  const parts = [
    onlyNew
      ? "Pages added to the wiki since this page was last checked (link to these only):"
      : "The wiki's pages (link, type, title, summary):",
    "<catalog>",
    ...catalogLines(targets),
    "</catalog>",
    "",
  ];
  if (dead.length) parts.push("Links in this page that lead nowhere:", ...dead.map((d) => `- [[${d}]]`), "");
  parts.push(`<page path="${page.path}">`, page.text.trim(), "</page>", "", "Suggest the links to add to this page.");
  return parts.join("\n");
}

export interface LinkProposal {
  text: string;
  target: string;
  reason?: string;
}
export interface LinkFix {
  link: string;
  target: string;
}

/** A suggestion the app couldn't carry out, and why. */
export interface Dropped {
  text: string;
  target: string;
  why: string;
}

/**
 * Read the model's reply, keeping only suggestions the app can carry out:
 * targets in the catalog (as their link), phrases that are in the page where
 * a link can go, one link per target, none to the page itself or to pages it
 * already links to.
 */
export function parseLinkReply(
  reply: string,
  page: WikiPage,
  targets: CatalogEntry[],
  index: FileIndex,
): { links: LinkProposal[]; fixes: LinkFix[]; dropped: Dropped[] } {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let raw: { links?: unknown; fixes?: unknown };
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The model's reply wasn't valid JSON.");
  }
  // Models name pages by their link, path, title or an alias; accept any of them.
  const byLink = new Map<string, CatalogEntry>();
  for (const c of targets) for (const name of [...c.aliases, c.title]) byLink.set(name.trim().toLowerCase(), c);
  for (const c of targets) {
    byLink.set(c.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase(), c);
    byLink.set(c.path.replace(/\.md$/, "").toLowerCase(), c);
    byLink.set(c.link.toLowerCase(), c);
  }
  const entryFor = (t: unknown) => {
    if (typeof t !== "string") return undefined;
    const key = t.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim().replace(/\.md$/, "").toLowerCase();
    return byLink.get(key);
  };
  const already = new Set(findWikiLinks(page.text).flatMap((l) => linkCandidates(l.target, index).slice(0, 1)));
  const used = new Set<string>();
  const links: LinkProposal[] = [];
  const dropped: Dropped[] = [];
  for (const item of Array.isArray(raw.links) ? raw.links : []) {
    const entry = entryFor(item?.target);
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    const drop = (why: string) => dropped.push({ text, target: typeof item?.target === "string" ? item.target : "?", why });
    if (!text) continue;
    if (!entry) drop("not a page in the wiki");
    else if (entry.path === page.path) drop("the page itself");
    else if (already.has(entry.path)) drop("already linked");
    else if (used.has(entry.path)) continue; // a second place for the same link
    else if (findPhrase(page.text, text) < 0) drop("phrase not found where a link can go");
    if (!entry || entry.path === page.path || already.has(entry.path) || used.has(entry.path) || findPhrase(page.text, text) < 0) continue;
    used.add(entry.path);
    links.push({ text, target: entry.link, ...(typeof item.reason === "string" && item.reason.trim() ? { reason: item.reason.trim() } : {}) });
    if (links.length >= MAX_LINKS) break;
  }
  const existing = new Set(findWikiLinks(bodyOf(page.text)).map((l) => l.target.split("#")[0].trim()));
  const fixes: LinkFix[] = [];
  for (const item of Array.isArray(raw.fixes) ? raw.fixes : []) {
    const entry = entryFor(item?.target);
    const link = typeof item?.link === "string" ? item.link.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim() : "";
    if (!entry || !existing.has(link) || linkCandidates(link, index).length > 0 || entry.path === page.path) continue;
    if (!fixes.some((f) => f.link === link)) fixes.push({ link, target: entry.link });
  }
  return { links, fixes, dropped };
}

// ---------------------------------------------------------------- applying links

/** Parts of a page where no link may be added: front matter, headings, code, math, tables, links, comments, URLs. */
export function protectedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const front = text.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  if (front) ranges.push([0, front[0].length]);
  ranges.push(...codeRanges(text));
  const patterns = [
    /\$\$[\s\S]*?\$\$/g, // display math
    /(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$/g, // inline math
    /\[\[[^\]\n]*\]\]/g, // wiki links
    /!?\[[^\]\n]*\]\([^)\n]*\)/g, // Markdown links and images
    /<!--[\s\S]*?-->/g,
    /<[^>\n]+>/g,
    /https?:\/\/\S+/g,
    /^#{1,6}\s.*$/gm, // headings
    /^\s*\|.*$/gm, // table rows (a | in a link would break them)
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

const WORD = /[\p{L}\p{N}_]/u;

/** Where `phrase` first appears as whole words outside protected parts (exact case first, then any case); -1 if nowhere. */
export function findPhrase(text: string, phrase: string, ranges = protectedRanges(text)): number {
  if (!phrase.trim()) return -1;
  const free = (start: number, end: number) => !ranges.some(([a, b]) => start < b && end > a);
  const bounded = (start: number, end: number) =>
    !(WORD.test(text[start - 1] ?? "") || (text[start - 1] === "-" && WORD.test(text[start - 2] ?? ""))) &&
    !(WORD.test(text[end] ?? "") || (text[end] === "-" && WORD.test(text[end + 1] ?? "")));
  for (const haystack of [text, text.toLowerCase()]) {
    const needle = haystack === text ? phrase : phrase.toLowerCase();
    for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
      if (bounded(i, i + needle.length) && free(i, i + needle.length)) return i;
    }
  }
  return -1;
}

/** A few words either side of a phrase's first place, for review. */
export function contextOf(text: string, phrase: string, width = 70): { before: string; match: string; after: string } | null {
  const i = findPhrase(text, phrase);
  if (i < 0) return null;
  const line = (s: string) => s.replace(/\s+/g, " ");
  const start = Math.max(0, text.lastIndexOf("\n", i) + 1, i - width);
  const lineEnd = text.indexOf("\n", i + phrase.length);
  const end = Math.min(lineEnd < 0 ? text.length : lineEnd, i + phrase.length + width);
  return {
    before: (start > 0 && text[start - 1] !== "\n" ? "…" : "") + line(text.slice(start, i)),
    match: text.slice(i, i + phrase.length),
    after: line(text.slice(i + phrase.length, end)) + (end < text.length && text[end] !== "\n" ? "…" : ""),
  };
}

/** `[[target]]` when the text reads as the target's name, else `[[target|text]]`. */
function linkFor(target: string, text: string): string {
  const name = target.split("/").pop() ?? target;
  return name === text ? `[[${target}]]` : `[[${target}|${text}]]`;
}

/**
 * Add links to a page: each phrase's first free place, and fixed targets for
 * links that led nowhere (keeping their text). Phrases no longer in the page
 * are skipped.
 */
export function applyLinks(
  text: string,
  links: LinkProposal[],
  fixes: LinkFix[] = [],
): { text: string; applied: number; skipped: string[] } {
  let out = text;
  let applied = 0;
  const skipped: string[] = [];
  for (const link of links) {
    const i = findPhrase(out, link.text);
    if (i < 0) {
      skipped.push(link.text);
      continue;
    }
    const found = out.slice(i, i + link.text.length);
    out = out.slice(0, i) + linkFor(link.target, found) + out.slice(i + link.text.length);
    applied++;
  }
  if (fixes.length) {
    const frontEnd = out.match(/^---\n[\s\S]*?\n---(?:\n|$)/)?.[0].length ?? 0;
    const found: FoundLink[] = findWikiLinks(out).filter((l) => l.index >= frontEnd);
    for (const l of found.reverse()) {
      const [name, fragment] = l.target.split("#", 2);
      const fix = fixes.find((f) => f.link === name.trim());
      if (!fix) continue;
      const target = fragment ? `${fix.target}#${fragment}` : fix.target;
      out = out.slice(0, l.index) + `[[${target}|${l.label ?? l.target}]]` + out.slice(l.index + l.length);
      applied++;
    }
  }
  return { text: out, applied, skipped };
}

// ---------------------------------------------------------------- the log

/** A lint entry for wiki/log.md, in the `## [date] operation | title` form. */
export function logEntry(date: string, changes: { path: string; links: number; fixes: number }[], report: LintReport): string {
  const linked = changes.filter((c) => c.links + c.fixes > 0);
  const total = linked.reduce((n, c) => n + c.links + c.fixes, 0);
  const lines = [`## [${date}] lint | ${total} link${total === 1 ? "" : "s"} added in ${linked.length} page${linked.length === 1 ? "" : "s"}`];
  for (const c of linked) {
    const what = [c.links && `${c.links} link${c.links === 1 ? "" : "s"}`, c.fixes && `${c.fixes} fixed`].filter(Boolean).join(", ");
    lines.push(`- [[${c.path.replace(/\.md$/, "")}]]: ${what}`);
  }
  lines.push(
    `- Checks: ${report.broken.length} broken links, ${report.ambiguous.length} ambiguous, ${report.missing.length} pages still to write, ${report.orphans.length} orphans, ${report.thin.length} thin pages`,
  );
  return `${lines.join("\n")}\n`;
}

export const NEW_LOG = `---\ntype: "wiki-log"\n---\n\n# Log\n\nPlato adds an entry here after each lint. Newest last.\n`;
