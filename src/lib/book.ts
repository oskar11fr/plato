// Books and other long documents, summarized one chapter at a time.
//
//   wiki/sources/<book>/00-overview.md    the book's overview (written by the model from the
//                                         chapter pages) above its contents (kept by the app)
//   wiki/sources/<book>/01-<chapter>.md   one page per chapter, in reading order
//
// The chapters come from the PDF's bookmarks; the reader checks the list
// (which to include, titles, start pages) before writing starts, and it stays
// fixed after that. Each chapter is written with the book's contents and the
// TL;DRs of the chapters before it, so it can refer back to them; the reader
// reviews it (the same versions, revisions and hand edits as a whole-document
// summary) and saves it, then moves on to the next.
//
// Once chapters are written, the model writes the book's overview from the
// chapter pages (not the book's text), reviewed and saved the same way.
//
// The draft lives in .reader/drafts/<document>/book.json.
import type { OutlineNode } from "../pdf/text";
import { parseFrontMatter, serializeFrontMatter, str, strList } from "./frontmatter";
import type { Skill } from "./skills";
import {
  byline,
  MAX_SOURCE_CHARS,
  slug,
  SOURCES_DIR,
  splitDraft,
  splitTitle,
  type MarkedPassage,
  type PageMeta,
  type SummaryVersion,
  versionChain,
} from "./summary";

/** Above this much text, summarizing chapter by chapter is suggested. */
export const BOOK_SUGGEST_CHARS = 150_000;
/** Chapter levels are chosen so chapters stay under this, where the bookmarks allow. */
const CHAPTER_TARGET_CHARS = 150_000;
/** Shorter sections (cover, title page, dedication) start out excluded. */
const MIN_SECTION_CHARS = 1_000;
/** Sections that start out excluded: front and back matter. */
const SKIPPED_TITLES =
  /^(cover|title( page)?|half[- ]title|copyright|dedication|(table of )?contents|index|bibliography|references|works cited|notes|endnotes|acknowledge?ments?|about the authors?|also by .*|praise for .*|list of (figures|tables|illustrations))$/i;

export const OVERVIEW_FILE = "00-overview.md";

export interface SavedPage {
  path: string;
  /** Index of the version saved. */
  version: number;
  digest: string;
}

export interface BookSection {
  title: string;
  /** Bookmark depth (0 = top level), for indenting the contents. */
  depth: number;
  /** First and last page, 1-based and inclusive. */
  start: number;
  end: number;
  include: boolean;
  /** Its wiki page; set for included sections once writing starts. */
  path?: string;
  versions: SummaryVersion[];
  /** Index of the version shown. */
  current: number;
  saved?: SavedPage;
}

/** The book's overview page, written from the chapter pages. */
export interface BookOverview {
  versions: SummaryVersion[];
  current: number;
  saved?: SavedPage;
  /** The saved chapters (their digests) the newest written version covers. */
  from?: string[];
}

/** `BookDraft.selected` when the overview is shown. */
export const OVERVIEW = -1;

export interface BookDraft {
  version: 1;
  kind: "book";
  /** Workspace path of the document. */
  source: string;
  /** The book's title, authors and year (from the PDF's metadata, checked by the reader). */
  meta: PageMeta;
  focus: string;
  includeHighlights: boolean;
  /** The bookmark level the sections were taken from. */
  level: number;
  sections: BookSection[];
  /** Index of the section shown, or OVERVIEW. */
  selected: number;
  overview?: BookOverview;
  /** The book's wiki folder. Set when writing starts; the sections are fixed from then on. */
  folder?: string;
}

// ---------------------------------------------------------------- sections

/** How many bookmark levels the outline has (0 for none). */
export function outlineLevels(outline: OutlineNode[]): number {
  return outline.reduce((n, node) => Math.max(n, 1 + outlineLevels(node.children)), 0);
}

export const sectionChars = (pages: string[], s: Pick<BookSection, "start" | "end">) =>
  pages.slice(s.start - 1, s.end).reduce((n, p) => n + p.trim().length, 0);

/**
 * The sections at a bookmark level: every bookmark down to that level, in
 * page order. Each runs to the page before the next one starts (or shares
 * its first page with the next, if they start on the same page). Bookmarks
 * with chapters under them (like "Part I"), front and back matter, and
 * near-empty sections start out excluded.
 */
export function sectionsFromOutline(outline: OutlineNode[], level: number, pages: string[]): BookSection[] {
  const numPages = pages.length;
  const rows: { title: string; depth: number; start: number; container: boolean; order: number }[] = [];
  const walk = (nodes: OutlineNode[], depth: number) => {
    for (const node of nodes) {
      const childrenInLevel = depth < level && node.children.some(hasPage);
      if (node.page !== null && node.page >= 1 && node.page <= numPages) {
        rows.push({ title: node.title || `Page ${node.page}`, depth, start: node.page, container: childrenInLevel, order: rows.length });
      }
      if (depth < level) walk(node.children, depth + 1);
    }
  };
  walk(outline, 0);
  rows.sort((a, b) => a.start - b.start || a.order - b.order);
  return rows.map((row, i) => {
    const next = rows[i + 1]?.start ?? numPages + 1;
    const section: BookSection = {
      title: row.title,
      depth: row.depth,
      start: row.start,
      end: Math.max(row.start, next - 1),
      include: false,
      versions: [],
      current: 0,
    };
    section.include = !row.container && !SKIPPED_TITLES.test(row.title.trim()) && sectionChars(pages, section) >= MIN_SECTION_CHARS;
    return section;
  });
}

const hasPage = (node: OutlineNode): boolean => node.page !== null || node.children.some(hasPage);

/**
 * The bookmark level to take chapters from: the first that splits the book
 * into chapters of a readable size, else the first where every chapter fits
 * in one request, else the deepest.
 */
export function suggestLevel(outline: OutlineNode[], pages: string[]): number {
  const levels = outlineLevels(outline);
  if (levels === 0) return 0;
  const longest = (level: number) => {
    const included = sectionsFromOutline(outline, level, pages).filter((s) => s.include);
    return included.length >= 2 ? Math.max(...included.map((s) => sectionChars(pages, s))) : Infinity;
  };
  for (const limit of [CHAPTER_TARGET_CHARS, MAX_SOURCE_CHARS]) {
    for (let level = 0; level < levels; level++) if (longest(level) <= limit) return level;
  }
  return levels - 1;
}

/** Recompute each section's last page after the reader changed start pages. */
export function withEnds(sections: BookSection[], numPages: number): BookSection[] {
  const sorted = sections
    .map((s) => ({ ...s, start: Math.min(Math.max(1, Math.round(s.start) || 1), numPages) }))
    .sort((a, b) => a.start - b.start);
  return sorted.map((s, i) => ({ ...s, end: Math.max(s.start, (sorted[i + 1]?.start ?? numPages + 1) - 1) }));
}

/** The sections that get a wiki page, with their indexes in `sections`. */
export function includedSections(draft: Pick<BookDraft, "sections">): { section: BookSection; index: number }[] {
  return draft.sections.flatMap((section, index) => (section.include ? [{ section, index }] : []));
}

/** A section's place among the included ones, 1-based (0 if excluded). */
export function chapterNumber(draft: Pick<BookDraft, "sections">, index: number): number {
  return includedSections(draft).findIndex((c) => c.index === index) + 1;
}

export const pageRange = (s: Pick<BookSection, "start" | "end">) => (s.start === s.end ? `p. ${s.start}` : `pp. ${s.start}–${s.end}`);

/** The first included section with nothing written yet, after `after` (or from the start). */
export function nextUnwritten(draft: Pick<BookDraft, "sections">, after = -1): number | null {
  const later = includedSections(draft).find((c) => c.index > after && c.section.versions.length === 0);
  return later?.index ?? includedSections(draft).find((c) => c.section.versions.length === 0)?.index ?? null;
}

/**
 * The book's wiki folder and a page path for every included section.
 * `taken` are the names already in wiki/sources/; `folder` reuses the folder
 * of an earlier run for this book.
 */
export function assignPaths(draft: BookDraft, taken: string[], folder?: string): BookDraft {
  let dir = folder;
  if (!dir) {
    const base = slug(draft.meta.title) || "book";
    let name = base;
    for (let i = 2; taken.includes(name) || taken.includes(`${name}.md`); i++) name = `${base}-${i}`;
    dir = `${SOURCES_DIR}/${name}`;
  }
  const count = includedSections(draft).length;
  const width = Math.max(2, String(count).length);
  const used = new Set<string>([OVERVIEW_FILE]);
  let n = 0;
  const sections = draft.sections.map((s) => {
    if (!s.include) return { ...s, path: undefined };
    n += 1;
    const base = `${String(n).padStart(width, "0")}-${slug(s.title) || "section"}`;
    let file = `${base}.md`;
    for (let i = 2; used.has(file); i++) file = `${base}-${i}.md`;
    used.add(file);
    return { ...s, path: `${dir}/${file}` };
  });
  return { ...draft, folder: dir, sections };
}

export const overviewPath = (folder: string) => `${folder}/${OVERVIEW_FILE}`;

const wikiTarget = (path: string) => path.replace(/\.md$/, "");
const linkLabel = (text: string) => text.replace(/[|\]]/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- the model

export function sectionSystemPrompt(docPath: string, skill: Skill): string {
  const cite = (n: number) => `[[${docPath}#page=${n}|p. ${n}]]`;
  return [
    "You write pages for a personal research wiki: Markdown files kept next to the reader's documents and linked to each other.",
    "The reader is working through a book one chapter at a time. Each chapter gets a page of its own; you write the page for one chapter.",
    "",
    "Output format (required, the app reads it):",
    "- Reply with the page only. No preamble or closing remarks, and don't wrap the page in a code block.",
    "- Start with front matter in exactly this shape, with values written as JSON:",
    "  ---",
    '  title: "<the chapter\'s own title>"',
    '  tldr: "<one or two sentences: what the chapter does and its main point>"',
    "  ---",
    "- Then the page body in Markdown, starting with a heading `# <title>`.",
    `- Cite pages of the book as wiki links, like ${cite(3)} for page 3, using the page numbers given in the text. When you refer back to an earlier chapter, cite its pages too.`,
    "- To refer to another chapter, link its wiki page as listed in the contents, e.g. [[wiki/sources/book/02-chapter|chapter 2]]. Don't invent links to chapters that aren't listed.",
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

/**
 * The request for one chapter: the book's contents, what the earlier
 * chapters said, the chapter's text, then the task.
 */
export function sectionRequestMessage(
  draft: BookDraft,
  index: number,
  pages: string[],
  options: { highlights?: MarkedPassage[] } = {},
): string {
  const section = draft.sections[index];
  const number = chapterNumber(draft, index);
  const chapters = includedSections(draft);
  const by = draft.meta.authors.length ? ` authors="${draft.meta.authors.join(", ")}"` : "";
  const year = draft.meta.year ? ` year="${draft.meta.year}"` : "";
  const parts = [`<book title="${draft.meta.title}"${by}${year} path="${draft.source}" pages="${pages.length}">`, "<contents>"];
  chapters.forEach(({ section: s, index: i }, n) => {
    const link = s.path && i !== index ? `: [[${wikiTarget(s.path)}]]` : "";
    parts.push(`${n + 1}. ${s.title}, ${pageRange(s)}${i === index ? " (this chapter)" : link}`);
  });
  parts.push("</contents>", "</book>", "");

  const earlier = chapters
    .filter((c) => c.index < index)
    .map(({ section: s }, n) => ({ n: n + 1, s, tldr: sectionTldr(s) }))
    .filter((c) => c.tldr);
  if (earlier.length) {
    parts.push("What the earlier chapters say (from their wiki pages):", "<earlier-chapters>");
    for (const c of earlier) parts.push(`${c.n}. ${c.s.title} (${pageRange(c.s)}): ${c.tldr}`);
    parts.push("</earlier-chapters>", "");
  }

  parts.push(`<chapter number="${number}" title="${section.title}" pages="${section.start}-${section.end}">`);
  for (let p = section.start; p <= section.end; p++) {
    const text = pages[p - 1]?.trim();
    if (text) parts.push(`<page number="${p}">`, text, "</page>");
  }
  parts.push("</chapter>", "");

  const marked = (options.highlights ?? []).filter((h) => h.quote.trim() && h.page >= section.start && h.page <= section.end);
  if (marked.length) {
    parts.push("Passages I highlighted in this chapter:", "<highlights>");
    for (const h of marked) parts.push(`- p. ${h.page}: "${h.quote.replace(/\s+/g, " ").trim()}"`);
    parts.push("</highlights>", "");
  }
  if (draft.focus.trim()) parts.push(`My focus for this book: ${draft.focus.trim()}`, "");
  parts.push(`Write the wiki page for chapter ${number} of ${chapters.length}, "${section.title}" (${pageRange(section)}).`);
  return parts.join("\n");
}

export function overviewSystemPrompt(docPath: string, skill: Skill): string {
  const cite = (n: number) => `[[${docPath}#page=${n}|p. ${n}]]`;
  return [
    "You write pages for a personal research wiki: Markdown files kept next to the reader's documents and linked to each other.",
    "The reader has summarized a book chapter by chapter, one wiki page per chapter. You write the book's overview page from those chapter pages. The app puts the book's contents (a linked list of the chapters) under your text, so don't repeat it as a list.",
    "",
    "Output format (required, the app reads it):",
    "- Reply with the page only. No preamble or closing remarks, and don't wrap the page in a code block.",
    "- Start with front matter in exactly this shape, with values written as JSON:",
    "  ---",
    '  title: "<the book\'s title>"',
    '  tldr: "<two or three sentences: what the book is about and its main argument>"',
    "  ---",
    "- Then the page body in Markdown, starting with a heading `# <title>`.",
    "- Link chapters by their wiki pages as given, e.g. [[wiki/sources/book/02-chapter|chapter 2]].",
    `- Cite pages of the book as wiki links, like ${cite(3)} for page 3, but only pages the chapter pages cite; you haven't read the book itself.`,
    "- Link concepts that deserve a wiki page of their own as [[concept name]], the way the chapter pages do: lowercase unless a proper noun, singular. Link each concept once, where it first matters.",
    "- Write all mathematics in LaTeX: $...$ inline, and $$...$$ on lines of their own for display equations.",
    "",
    "When the reader asks for changes, reply with the complete revised page in the same format. Change what they ask for and keep everything else as it is, word for word. If they edited the page by hand, keep their edits.",
    "",
    `Instructions for this page (skill "${skill.name}"):`,
    "",
    skill.instructions,
  ].join("\n");
}

/** The request for the overview: the book's details and contents, then every chapter page written so far. */
export function overviewRequestMessage(draft: BookDraft): string {
  const chapters = includedSections(draft);
  const by = draft.meta.authors.length ? ` authors="${draft.meta.authors.join(", ")}"` : "";
  const year = draft.meta.year ? ` year="${draft.meta.year}"` : "";
  const parts = [`<book title="${draft.meta.title}"${by}${year} path="${draft.source}">`, "<contents>"];
  chapters.forEach(({ section: s }, n) => {
    const link = s.path && s.versions.length ? `: [[${wikiTarget(s.path)}]]` : " (not summarized yet)";
    parts.push(`${n + 1}. ${s.title}, ${pageRange(s)}${link}`);
  });
  parts.push("</contents>", "</book>", "");

  const written = chapters.flatMap(({ section: s }, n) => {
    const v = s.versions[s.saved?.version ?? s.current] ?? s.versions[s.current];
    return v ? [{ n: n + 1, s, page: parseSection(v.text) }] : [];
  });
  parts.push("The chapter pages:", "");
  for (const { n, s, page } of written) {
    const path = s.path ? ` path="${wikiTarget(s.path)}"` : "";
    parts.push(`<chapter number="${n}" title="${s.title}" pages="${s.start}-${s.end}"${path}>`);
    if (page.tldr) parts.push(`TL;DR: ${page.tldr}`, "");
    parts.push(splitTitle(page.body.trim()).rest.trim(), "</chapter>", "");
  }
  if (draft.focus.trim()) parts.push(`My focus for this book: ${draft.focus.trim()}`, "");
  const missing = chapters.length - written.length;
  parts.push(
    missing > 0
      ? `Write the overview page for this book. ${missing} of its ${chapters.length} chapters aren't summarized yet; cover the others and say briefly what's missing.`
      : "Write the overview page for this book.",
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------- pages

export interface SectionPage {
  title: string;
  tldr: string;
  body: string;
}

/** A chapter version's title, TL;DR and body (works mid-stream). */
export function parseSection(text: string): SectionPage {
  const { front, body } = splitDraft(text);
  return { title: str(front.title).trim(), tldr: str(front.tldr).trim(), body };
}

/** The TL;DR of the version that counts: the saved one, else the one shown. */
export function sectionTldr(section: BookSection): string {
  const version = section.versions[section.saved?.version ?? section.current] ?? section.versions[section.current];
  return version ? parseSection(version.text).tldr : "";
}

export function sectionDraftText(page: SectionPage): string {
  return `${serializeFrontMatter([
    ["title", page.title],
    ["tldr", page.tldr],
  ])}\n${page.body.trim()}\n`;
}

/** The line under a chapter page's title that links to the book. */
function bookLine(draft: BookDraft, section: BookSection): string {
  return `*From [[${wikiTarget(overviewPath(draft.folder ?? ""))}|${linkLabel(draft.meta.title)}]], ${pageRange(section)}.*`;
}
const BOOK_LINE = /^\*From \[\[[^\]]*\/00-overview(\|[^\]]*)?\]\].*\*$/;

/** The chapter's wiki file. */
export function sectionPageText(
  draft: BookDraft,
  index: number,
  page: SectionPage,
  info: { created: string; updated: string; model?: string },
): string {
  const section = draft.sections[index];
  const title = page.title || section.title;
  const { title: heading, rest } = splitTitle(page.body.trim());
  const body = `# ${heading ?? title}\n\n${bookLine(draft, section)}\n\n${rest.trim()}`;
  const front = serializeFrontMatter([
    ["type", "source-section"],
    ["title", title],
    ["tldr", page.tldr || undefined],
    ["book", `[[${wikiTarget(overviewPath(draft.folder ?? ""))}]]`],
    ["chapter", chapterNumber(draft, index)],
    ["pages", [section.start, section.end]],
    ["source", `[[${draft.source}#page=${section.start}]]`],
    ["created", info.created],
    ["updated", info.updated],
    ["model", info.model],
  ]);
  return `${front}\n${body.trim()}\n`;
}

/** Read a saved chapter page back into a draft version's text. */
export function sectionPageToDraft(text: string): string {
  const { front, body } = parseFrontMatter(text);
  const { title, rest } = splitTitle(body.replace(/^\n+/, ""));
  const lines = rest.split("\n");
  if (BOOK_LINE.test(lines[0]?.trim() ?? "")) lines.shift();
  const kept = `${title ? `# ${title}\n\n` : ""}${lines.join("\n").replace(/^\n+/, "")}`;
  return sectionDraftText({ title: str(front.title), tldr: str(front.tldr), body: kept });
}

/** Between the overview the model wrote and the contents the app keeps up to date. */
export const CONTENTS_MARKER =
  "<!-- Plato keeps the contents below up to date. Change the overview above in Plato's summary pane: edits made here are replaced. -->";

/** The version of the overview that's in the wiki, if any. */
function savedOverview(draft: BookDraft): { page: SectionPage; model?: string } | null {
  const o = draft.overview;
  const v = o?.saved ? o.versions[o.saved.version] : undefined;
  if (!o?.saved || !v) return null;
  const model = [...versionChain(o.versions, o.saved.version)].reverse().find((x) => x.model)?.model;
  return { page: parseSection(v.text), model };
}

/**
 * The book's overview page: its details, the overview the model wrote (once
 * saved), and its contents with a link to every saved chapter. The app
 * rewrites it whenever a chapter or the overview is saved.
 */
export function overviewPageText(draft: BookDraft, info: { created: string; updated: string }): string {
  const overview = savedOverview(draft);
  const front = serializeFrontMatter([
    ["type", "source-summary"],
    ["kind", "book"],
    ["title", draft.meta.title],
    ["authors", draft.meta.authors],
    ["year", draft.meta.year],
    ["tldr", overview?.page.tldr || undefined],
    ["source", `[[${draft.source}]]`],
    ["created", info.created],
    ["updated", info.updated],
    ["model", overview?.model],
  ]);
  const by = byline(draft.meta);
  const lines = [
    `# ${draft.meta.title}`,
    "",
    [by, `[[${draft.source}|${linkLabel(draft.source.split("/").pop() ?? draft.source)}]]`].filter(Boolean).join(" · "),
    "",
  ];
  const text = overview ? splitTitle(overview.page.body.trim()).rest.trim() : "";
  if (text) lines.push(text, "");
  lines.push(CONTENTS_MARKER, "", "## Contents", "");
  includedSections(draft).forEach(({ section: s }, n) => {
    const tldr = s.saved ? sectionTldr(s) : "";
    const entry = s.saved && s.path ? `[[${wikiTarget(s.path)}|${linkLabel(s.title)}]]` : `${s.title} *(not summarized yet)*`;
    lines.push(`${n + 1}. ${entry}, ${pageRange(s)}${tldr ? `: ${tldr}` : ""}`);
  });
  return `${front}\n${lines.join("\n")}\n`;
}

/** The overview the model wrote, from a saved overview page, as a draft version's text (null if it has none). */
export function overviewPageToDraft(text: string): string | null {
  const { front, body } = parseFrontMatter(text);
  const marker = body.indexOf(CONTENTS_MARKER);
  const contents = body.search(/^## Contents$/m);
  const end = marker >= 0 ? marker : contents >= 0 ? contents : body.length;
  const { title, rest } = splitTitle(body.slice(0, end).replace(/^\n+/, ""));
  const lines = rest.split("\n");
  const source = str(front.source).replace(/^\[\[|\]\]$/g, "");
  if (source && lines[0]?.includes(`[[${source}`)) lines.shift(); // the byline
  const kept = lines.join("\n").trim();
  if (!kept || kept.startsWith("<!--")) return null;
  const heading = str(front.title) || title || "";
  return sectionDraftText({ title: heading, tldr: str(front.tldr), body: `# ${heading}\n\n${kept}` });
}

/** Digests of the saved chapters, to tell when the overview is out of date. */
export const savedChapterDigests = (draft: BookDraft) =>
  includedSections(draft).flatMap((c) => (c.section.saved ? [c.section.saved.digest] : []));

/** How many chapters were saved (or saved again) since the overview's newest written version. */
export function chaptersChangedSince(draft: BookDraft): number {
  const from = draft.overview?.from;
  if (!from || !draft.overview?.versions.length) return 0;
  return savedChapterDigests(draft).filter((d) => !from.includes(d)).length;
}

/** Whether a wiki page is a book's overview (as opposed to a one-page summary). */
export const isBookOverview = (text: string) => str(parseFrontMatter(text).front.kind) === "book";

/** The book details of a saved overview page, to start a new run from. */
export function overviewMeta(text: string): PageMeta {
  const { front } = parseFrontMatter(text);
  return { title: str(front.title), authors: strList(front.authors), year: typeof front.year === "number" ? front.year : null };
}

/** Book details from the PDF's metadata, falling back to the file name. */
export function metaFromInfo(info: { title: string; author: string }, docPath: string): PageMeta {
  const fileTitle = (docPath.split("/").pop() ?? docPath).replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  const junk = /^(untitled|microsoft word|document\d*)\b|\.(docx?|pdf|indd|tex)$/i;
  const title = info.title && !junk.test(info.title) ? info.title : fileTitle;
  const authors = info.author
    .split(/\s*(?:;|&|,| and )\s*/)
    .map((a) => a.trim())
    .filter(Boolean);
  return { title, authors, year: null };
}
