// The wiki on disk: a visible `wiki/` folder in the workspace.
//
//   wiki/index.md               every source page, kept up to date by the app
//   wiki/sources/<title>.md     one page per summarized document
//   wiki/concepts/<name>.md     (later) pages for [[concept]] links
//
// Drafts that haven't been saved yet live in .reader/drafts/<document>/.
import { sha256 } from "./annotations";
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

/** All source pages in the wiki. */
async function sourcePages(): Promise<{ path: string; text: string }[]> {
  const entries = await listDir(SOURCES_DIR);
  const pages = await Promise.all(
    entries
      .filter((e) => !e.is_dir && e.name.endsWith(".md"))
      .map(async (e) => {
        const path = `${SOURCES_DIR}/${e.name}`;
        return { path, text: await readTextFile(path).catch(() => "") };
      }),
  );
  return pages.filter((p) => p.text);
}

/** The wiki page that summarizes a document, if there is one. */
export async function findSourcePage(docPath: string): Promise<{ path: string; text: string } | null> {
  return (await sourcePages()).find((p) => wikiPageSource(p.text) === docPath) ?? null;
}

export async function newSourcePagePath(title: string): Promise<string> {
  const existing = (await listDir(SOURCES_DIR)).map((e) => e.name);
  return `${SOURCES_DIR}/${summaryFileName(title, existing)}`;
}

export const digest = (text: string) => sha256(new TextEncoder().encode(text));

export async function writeWikiPage(path: string, text: string) {
  await writeTextFile(path, text);
  await updateWikiIndex();
}

/** Rewrite wiki/index.md from the source pages. */
export async function updateWikiIndex() {
  const entries: IndexEntry[] = (await sourcePages()).map(({ path, text }) => {
    const { front } = parseFrontMatter(text);
    return {
      path,
      title: str(front.title) || (path.split("/").pop() ?? path).replace(/\.md$/, ""),
      authors: strList(front.authors),
      year: typeof front.year === "number" ? front.year : null,
    };
  });
  await writeTextFile(INDEX_FILE, wikiIndexText(entries));
}
