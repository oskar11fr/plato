// The wiki on disk: a visible `wiki/` folder in the workspace.
//
//   wiki/index.md                       every source page, kept up to date by the app
//   wiki/sources/<title>.md             one page per summarized document
//   wiki/sources/<book>/00-overview.md  a book summarized chapter by chapter,
//   wiki/sources/<book>/01-<chapter>.md   with one page per chapter (see book.ts)
//   wiki/concepts/<name>.md             (later) pages for [[concept]] links
//
// Drafts that haven't been saved yet live in .reader/drafts/<document>/.
import { sha256 } from "./annotations";
import type { BookDraft } from "./book";
import { deleteAppFile, listDir, READER_DIR, readTextFile, readTextFileOpt, writeTextFile } from "./backend";
import { parseFrontMatter, str, strList } from "./frontmatter";
import {
  INDEX_FILE,
  SOURCES_DIR,
  summaryFileName,
  wikiIndexText,
  wikiPageSource,
  type IndexEntry,
  type SummaryDraft,
} from "./summary";

const draftPath = (docPath: string) => `${READER_DIR}/drafts/${docPath}/summary.json`;

export async function loadDraft(docPath: string): Promise<SummaryDraft | null> {
  const raw = await readTextFileOpt(draftPath(docPath));
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as SummaryDraft;
    if (draft.version !== 1 || !Array.isArray(draft.versions)) return null;
    draft.source = docPath; // the document may have moved since
    return draft;
  } catch {
    return null;
  }
}

// Saves run one at a time, so an older draft never lands after a newer one.
let draftQueue: Promise<unknown> = Promise.resolve();

export function saveDraft(draft: SummaryDraft): Promise<void> {
  const contents = `${JSON.stringify(draft, null, 2)}\n`;
  const save = draftQueue.then(() => writeTextFile(draftPath(draft.source), contents));
  draftQueue = save.catch(() => {});
  return save;
}

export async function deleteDraft(docPath: string) {
  await draftQueue;
  if ((await readTextFileOpt(draftPath(docPath))) !== null) await deleteAppFile(draftPath(docPath));
}

const bookPath = (docPath: string) => `${READER_DIR}/drafts/${docPath}/book.json`;

export async function loadBookDraft(docPath: string): Promise<BookDraft | null> {
  const raw = await readTextFileOpt(bookPath(docPath));
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as BookDraft;
    if (draft.version !== 1 || draft.kind !== "book" || !Array.isArray(draft.sections)) return null;
    draft.source = docPath; // the document may have moved since
    return draft;
  } catch {
    return null;
  }
}

export function saveBookDraft(draft: BookDraft): Promise<void> {
  const contents = `${JSON.stringify(draft, null, 2)}\n`;
  const save = draftQueue.then(() => writeTextFile(bookPath(draft.source), contents));
  draftQueue = save.catch(() => {});
  return save;
}

export async function deleteBookDraft(docPath: string) {
  await draftQueue;
  if ((await readTextFileOpt(bookPath(docPath))) !== null) await deleteAppFile(bookPath(docPath));
}

interface WikiFile {
  path: string;
  text: string;
}

async function readPages(dir: string): Promise<WikiFile[]> {
  const entries = await listDir(dir).catch(() => []);
  const pages = await Promise.all(
    entries
      .filter((e) => !e.is_dir && e.name.endsWith(".md"))
      .map(async (e) => {
        const path = `${dir}/${e.name}`;
        return { path, text: await readTextFile(path).catch(() => "") };
      }),
  );
  return pages.filter((p) => p.text).sort((a, b) => a.path.localeCompare(b.path));
}

/** Source pages in the wiki: one-page summaries, and books' overview pages with their chapter pages. */
async function sourcePages(): Promise<(WikiFile & { chapters: WikiFile[] })[]> {
  const entries = await listDir(SOURCES_DIR);
  const flat = (await readPages(SOURCES_DIR)).map((p) => ({ ...p, chapters: [] }));
  const books = await Promise.all(
    entries
      .filter((e) => e.is_dir && !e.name.startsWith("."))
      .map(async (e) => {
        const pages = await readPages(`${SOURCES_DIR}/${e.name}`);
        const isChapter = (p: WikiFile) => str(parseFrontMatter(p.text).front.type) === "source-section";
        const overview = pages.find((p) => str(parseFrontMatter(p.text).front.type) === "source-summary");
        return overview ? [{ ...overview, chapters: pages.filter(isChapter) }] : [];
      }),
  );
  return [...flat, ...books.flat()];
}

/** The wiki page that summarizes a document (a book's overview page), if there is one. */
export async function findSourcePage(docPath: string): Promise<WikiFile | null> {
  const pages = (await sourcePages()).filter((p) => wikiPageSource(p.text) === docPath);
  return pages.find((p) => p.chapters.length > 0 || p.path.endsWith("/00-overview.md")) ?? pages[0] ?? null;
}

/** Names in wiki/sources/ (files and book folders). */
export async function sourceNames(): Promise<string[]> {
  return (await listDir(SOURCES_DIR).catch(() => [])).map((e) => e.name);
}

export async function newSourcePagePath(title: string): Promise<string> {
  const existing = (await listDir(SOURCES_DIR)).map((e) => e.name);
  return `${SOURCES_DIR}/${summaryFileName(title, existing)}`;
}

export const digest = (text: string) => sha256(new TextEncoder().encode(text));

/** Write wiki pages, then rebuild the index. */
export async function writeWikiPage(path: string, text: string, ...more: [string, string][]) {
  await writeTextFile(path, text);
  for (const [p, t] of more) await writeTextFile(p, t);
  await updateWikiIndex();
}

/** Rewrite wiki/index.md from the source pages. */
export async function updateWikiIndex() {
  const titleOf = (path: string, front: Record<string, unknown>) =>
    str(front.title) || (path.split("/").pop() ?? path).replace(/\.md$/, "");
  const entries: IndexEntry[] = (await sourcePages()).map(({ path, text, chapters }) => {
    const { front } = parseFrontMatter(text);
    return {
      path,
      title: titleOf(path, front),
      authors: strList(front.authors),
      year: typeof front.year === "number" ? front.year : null,
      ...(chapters.length
        ? { chapters: chapters.map((c) => ({ path: c.path, title: titleOf(c.path, parseFrontMatter(c.text).front) })) }
        : {}),
    };
  });
  await writeTextFile(INDEX_FILE, wikiIndexText(entries));
}
