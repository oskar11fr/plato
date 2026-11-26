// Summaries of source documents, written by the model as wiki pages.
//
// A draft is a list of versions. Each version is the whole page as Markdown
// with a little front matter (title, authors, year), written by the model or
// edited by hand, and based on an earlier version. Asking for changes sends
// the chain of versions that led to the shown one as a conversation, so the
// model sees what it wrote and what the reader asked for along the way.
//
// The system prompt has two parts: a fixed output contract (the app parses
// the result, so the reader can't break it by editing a skill), and the
// skill's instructions (what a good summary is; the reader can change them).
import type { ChatMessage } from "./llm";
import { parseFrontMatter, serializeFrontMatter, str, strList } from "./frontmatter";
import type { Skill } from "./skills";

export interface SummaryVersion {
  /** The page: front matter (title, authors, year) and Markdown body. */
  text: string;
  /** "ai": written by the model; "edit": changed by hand; "wiki": loaded from the saved wiki page. */
  by: "ai" | "edit" | "wiki";
  /** Index of the version this one was made from (none for a first draft). */
  basedOn?: number;
  /** What the reader asked for, for a revision by the model. */
  feedback?: string;
  model?: string;
  at: string;
  /** e.g. "Cut off at the length limit." */
  note?: string;
}

export interface SummaryDraft {
  version: 1;
  /** Workspace path of the summarized document. */
  source: string;
  focus: string;
  includeHighlights: boolean;
  versions: SummaryVersion[];
  /** Index of the version shown. */
  current: number;
  /** The last save to the wiki. */
  saved?: { path: string; version: number; digest: string };
}

export interface PageMeta {
  title: string;
  authors: string[];
  year: number | null;
}

/** A highlight the reader made, sent as a hint of what matters to them. */
export interface MarkedPassage {
  page: number;
  quote: string;
}

/** The most text sent in one request; longer documents are summarized chapter by chapter. */
export const MAX_SOURCE_CHARS = 400_000;
/** Below this, the PDF most likely has no text layer (a scan). */
export const MIN_SOURCE_CHARS = 200;

export const WIKI_DIR = "wiki";
export const SOURCES_DIR = `${WIKI_DIR}/sources`;
export const CONCEPTS_DIR = `${WIKI_DIR}/concepts`;
export const INDEX_FILE = `${WIKI_DIR}/index.md`;

export function summarySystemPrompt(docPath: string, skill: Skill): string {
  const cite = (n: number) => `[[${docPath}#page=${n}|p. ${n}]]`;
  return [
    "You write pages for a personal research wiki: Markdown files kept next to the reader's documents and linked to each other.",
    "",
    "Output format (required, the app reads it):",
    "- Reply with the page only. No preamble or closing remarks, and don't wrap the page in a code block.",
    "- Start with front matter in exactly this shape, with values written as JSON:",
    "  ---",
    '  title: "<the document\'s own title>"',
    '  authors: ["<author>", "<author>"]',
    "  year: <year as a number, or null>",
    "  ---",
    "- Then the page body in Markdown, starting with a heading `# <title>`.",
    `- Cite pages of the document as wiki links, like ${cite(3)} for page 3.`,
    "- Link concepts that deserve a wiki page of their own as [[concept name]]: lowercase unless a proper noun, singular, e.g. [[self-attention]] or [[BLEU]]. Link each concept once, where it first matters.",
    "- Write all mathematics in LaTeX: $...$ inline, and $$...$$ on lines of their own for display equations.",
    "",
    "When the reader asks for changes, reply with the complete revised page in the same format. Change what they ask for and keep everything else as it is, word for word. If they edited the page by hand, keep their edits.",
    "",
    `Instructions for this page (skill "${skill.name}"):`,
    "",
    skill.instructions,
  ].join("\n");
}

/** The document, then the task: long material first, the request last. */
export function summaryRequestMessage(
  docPath: string,
  pages: string[],
  options: { focus?: string; highlights?: MarkedPassage[] } = {},
): string {
  const parts = [`<document path="${docPath}" pages="${pages.length}">`];
  pages.forEach((text, i) => {
    if (text.trim()) parts.push(`<page number="${i + 1}">`, text.trim(), "</page>");
  });
  parts.push("</document>", "");
  const marked = options.highlights?.filter((h) => h.quote.trim()) ?? [];
  if (marked.length) {
    parts.push("Passages I highlighted while reading:", "<highlights>");
    for (const h of marked) parts.push(`- p. ${h.page}: "${h.quote.replace(/\s+/g, " ").trim()}"`);
    parts.push("</highlights>", "");
  }
  if (options.focus?.trim()) parts.push(`Focus: ${options.focus.trim()}`, "");
  parts.push("Write the wiki page summarizing this document.");
  return parts.join("\n");
}

export const sourceLength = (pages: string[]) => pages.reduce((n, p) => n + p.trim().length, 0);

/** The versions leading to `index`, oldest first. */
export function versionChain(versions: SummaryVersion[], index: number): SummaryVersion[] {
  const chain: SummaryVersion[] = [];
  const seen = new Set<number>();
  for (let i: number | undefined = index; i !== undefined && !seen.has(i) && versions[i]; i = versions[i].basedOn) {
    seen.add(i);
    chain.unshift(versions[i]);
  }
  return chain;
}

/**
 * The conversation for revising version `index` with `feedback`. Hand edits
 * (and a page loaded from the wiki) take the place of the model's last reply,
 * and the reader's next message says so.
 */
export function revisionMessages(
  request: string,
  versions: SummaryVersion[],
  index: number,
  feedback: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: request }];
  let edited = false;
  const ask = (text: string) => {
    const note = edited ? "I edited the page by hand; keep my edits unless I ask otherwise.\n\n" : "";
    edited = false;
    messages.push({ role: "user", content: `${note}${text}` });
  };
  for (const v of versionChain(versions, index)) {
    const last = messages[messages.length - 1];
    if (v.by === "ai") {
      if (last.role === "assistant") ask(v.feedback?.trim() || "Revise the page.");
      messages.push({ role: "assistant", content: v.text });
    } else {
      if (last.role === "assistant") last.content = v.text;
      else messages.push({ role: "assistant", content: v.text });
      edited = true;
    }
  }
  ask(feedback.trim());
  return messages;
}

/** Remove a code fence the model wrapped the whole page in, despite instructions. */
function unwrapFence(text: string): string {
  const m = text.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return m ? m[1] : text;
}

/** A version's front matter and body; an empty body while the front matter is still streaming. */
export function splitDraft(text: string): { front: Record<string, unknown>; body: string } {
  const clean = unwrapFence(text).replace(/^\s+(?=---\n)/, "");
  if (clean.startsWith("---\n") && !/\n---(\n|$)/.test(clean.slice(4))) return { front: {}, body: "" };
  const { front, body } = parseFrontMatter(clean);
  return { front, body: body.replace(/^\n+/, "") };
}

/** Split a version's text into its metadata and body (works mid-stream). */
export function parseDraft(text: string): { meta: PageMeta; body: string } {
  const { front, body } = splitDraft(text);
  const year = typeof front.year === "number" ? front.year : Number.parseInt(str(front.year), 10);
  return {
    meta: { title: str(front.title).trim(), authors: strList(front.authors), year: Number.isFinite(year) ? year : null },
    body,
  };
}

/** A page's title: its metadata, else its first heading, else the file name. */
export function pageTitle(meta: PageMeta, body: string, docPath: string): string {
  return meta.title || body.match(/^# (.+)$/m)?.[1].trim() || (docPath.split("/").pop() ?? docPath);
}

/** A page body's leading `# Title` line, split from the rest. */
export function splitTitle(body: string): { title: string | null; rest: string } {
  const m = body.match(/^# (.+)(?:\n+|$)/);
  return m ? { title: m[1].trim(), rest: body.slice(m[0].length) } : { title: null, rest: body };
}

/** The draft text for a page (front matter with what the model may change, then the body). */
export function draftText(meta: PageMeta, body: string): string {
  return `${serializeFrontMatter([
    ["title", meta.title],
    ["authors", meta.authors],
    ["year", meta.year],
  ])}\n${body.trim()}\n`;
}

/** The wiki file: the app's own metadata around the draft's. */
export function wikiPageText(
  draft: { meta: PageMeta; body: string },
  info: { source: string; created: string; updated: string; model?: string },
): string {
  const title = pageTitle(draft.meta, draft.body, info.source);
  let body = draft.body.trim();
  if (!/^# /.test(body)) body = `# ${title}\n\n${body}`;
  const front = serializeFrontMatter([
    ["type", "source-summary"],
    ["title", title],
    ["authors", draft.meta.authors],
    ["year", draft.meta.year],
    ["source", `[[${info.source}]]`],
    ["created", info.created],
    ["updated", info.updated],
    ["model", info.model],
  ]);
  return `${front}\n${body}\n`;
}

/** Read a saved wiki page back into a draft version's text. */
export function wikiPageToDraft(text: string): string {
  const { front, body } = parseFrontMatter(text);
  const year = typeof front.year === "number" ? front.year : null;
  return draftText({ title: str(front.title), authors: strList(front.authors), year }, body);
}

/** The document a wiki page summarizes (its `source: "[[path]]"`). */
export function wikiPageSource(text: string): string | null {
  const { front } = parseFrontMatter(text);
  const m = str(front.source).match(/^\[\[([^\]|#]+)/);
  return m ? m[1] : null;
}

export function summaryFileName(title: string, existing: string[]): string {
  const base = slug(title) || "summary";
  let name = `${base}.md`;
  for (let i = 2; existing.includes(name); i++) name = `${base}-${i}.md`;
  return name;
}

export function slug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/** "Vaswani et al., 2017" */
export function byline(meta: Pick<PageMeta, "authors" | "year">): string {
  const surname = (a: string) => a.trim().split(/\s+/).pop() ?? a;
  const a = meta.authors;
  const who = a.length === 0 ? "" : a.length === 1 ? surname(a[0]) : a.length === 2 ? `${surname(a[0])} and ${surname(a[1])}` : `${surname(a[0])} et al.`;
  return [who, meta.year ?? ""].filter(Boolean).join(", ");
}

export interface IndexEntry {
  path: string;
  title: string;
  authors: string[];
  year: number | null;
  /** A book's chapter pages, in order. */
  chapters?: { path: string; title: string }[];
}

/** wiki/index.md: every source page, by title (a book with its chapters). Rewritten on each save. */
export function wikiIndexText(entries: IndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  const lines = [
    serializeFrontMatter([["type", "wiki-index"]]),
    "# Wiki",
    "",
    "<!-- Plato rewrites this page whenever a summary is saved. -->",
    "",
    "## Sources",
    "",
  ];
  const link = (path: string, title: string) => `[[${path.replace(/\.md$/, "")}|${title.replace(/[|\]]/g, " ")}]]`;
  if (sorted.length === 0) lines.push("No summaries yet.");
  for (const e of sorted) {
    const by = byline(e);
    lines.push(`- ${link(e.path, e.title)}${by ? ` (${by})` : ""}`);
    for (const c of e.chapters ?? []) lines.push(`  - ${link(c.path, c.title)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Top-level Markdown blocks (blank-line separated, keeping code and $$ blocks whole). */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let math = false;
  const flush = () => {
    if (current.some((l) => l.trim())) blocks.push(current.join("\n").trim());
    current = [];
  };
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (fence) {
      current.push(line);
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    if (math) {
      current.push(line);
      if (t.endsWith("$$")) math = false;
      continue;
    }
    const open = t.match(/^(```|~~~)/);
    if (open) {
      fence = open[1];
      current.push(line);
      continue;
    }
    if (t.startsWith("$$") && !(t.length > 2 && t.endsWith("$$") && t !== "$$")) {
      math = t === "$$" || !t.slice(2).includes("$$");
      current.push(line);
      continue;
    }
    if (t === "") flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/** For each block of `next`, whether it is new or changed compared to `prev`. */
export function changedBlocks(prev: string, next: string): { block: string; changed: boolean }[] {
  const norm = (b: string) => b.replace(/\s+/g, " ").trim();
  const before = new Set(splitBlocks(prev).map(norm));
  return splitBlocks(next).map((block) => ({ block, changed: !before.has(norm(block)) }));
}
