// Highlight records, stored per document in .reader/annotations/<path>.json.
// Shape follows the W3C Web Annotation idea: a text quote selector
// (quote + prefix/suffix) plus a position (rects as fractions of the page).
import { READER_DIR, readTextFileOpt, writeTextFile } from "./backend";

/** [x0, y0, x1, y1] as fractions of page width/height, so zoom does not matter. */
export type Rect = [number, number, number, number];

export interface Highlight {
  id: string;
  page: number;
  quote: string;
  prefix: string;
  suffix: string;
  rects: Rect[];
  color: string;
  /** Link to the chat turn this highlight started, e.g. "chats/x.pdf.md#turn-3". */
  chatTurn: string | null;
  created: string;
  /** Set when the file changed and the quote could not be found again. */
  detached?: boolean;
}

export interface AnnotationFile {
  version: 1;
  file: string;
  fileHash: string;
  highlights: Highlight[];
}

const annotationsPath = (docPath: string) => `${READER_DIR}/annotations/${docPath}.json`;

export async function loadAnnotations(docPath: string): Promise<AnnotationFile> {
  const raw = await readTextFileOpt(annotationsPath(docPath));
  if (raw) {
    const parsed = JSON.parse(raw) as AnnotationFile;
    if (parsed.version === 1 && Array.isArray(parsed.highlights)) return parsed;
    throw new Error(`Unsupported annotation file version for ${docPath}`);
  }
  return { version: 1, file: docPath, fileHash: "", highlights: [] };
}

// Saves run one at a time, so an older snapshot never lands after a newer one.
let saveQueue: Promise<unknown> = Promise.resolve();

export function saveAnnotations(store: AnnotationFile): Promise<void> {
  const contents = JSON.stringify(store, null, 2) + "\n";
  const save = saveQueue.then(() => writeTextFile(annotationsPath(store.file), contents));
  saveQueue = save.catch(() => {});
  return save;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export const newHighlightId = () => `hl-${crypto.randomUUID().slice(0, 8)}`;

/** Resolves once every queued annotation save has been written. */
export const flushAnnotationSaves = () => saveQueue.then(() => undefined);
