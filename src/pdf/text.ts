// Plain text of a PDF, page by page, from pdf.js's text content (the same
// text the viewer's text layer is built from).
import type { PDFDocumentProxy } from "pdfjs-dist";
import { readBinaryFile } from "../lib/backend";
import { loadPdfjs } from "./pdfjs";

/** One page's text, with line breaks where the PDF has them. */
export async function pageTextOf(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A PDF bookmark, resolved to the page it points at (1-based; null if it points nowhere). */
export interface OutlineNode {
  title: string;
  page: number | null;
  children: OutlineNode[];
}

export interface DocumentContents {
  /** Every page's text (index 0 = page 1). */
  pages: string[];
  /** The PDF's bookmarks; empty if it has none. */
  outline: OutlineNode[];
  /** The title and author the PDF's metadata claims (often missing or junk). */
  info: { title: string; author: string };
}

type PdfOutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

async function resolveOutline(doc: PDFDocumentProxy, items: PdfOutlineItem[] | null | undefined): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = [];
  for (const item of items ?? []) {
    let page: number | null = null;
    try {
      const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
      const target = Array.isArray(dest) ? dest[0] : null;
      if (typeof target === "number") page = target + 1;
      else if (target && typeof target === "object") page = (await doc.getPageIndex(target as never)) + 1;
    } catch {
      page = null; // a broken bookmark; its children may still work
    }
    nodes.push({ title: (item.title ?? "").replace(/\s+/g, " ").trim(), page, children: await resolveOutline(doc, item.items) });
  }
  return nodes;
}

/** An open PDF's text, bookmarks and metadata. */
export async function contentsOf(doc: PDFDocumentProxy): Promise<DocumentContents> {
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push(await pageTextOf(doc, n));
  const outline = await resolveOutline(doc, await doc.getOutline().catch(() => null));
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: unknown; Author?: unknown };
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { pages, outline, info: { title: text(info.Title), author: text(info.Author) } };
}

/** A workspace PDF's text, bookmarks and metadata, read in one go. */
export async function documentContents(path: string): Promise<DocumentContents> {
  const { pdfjsLib } = await loadPdfjs();
  const bytes = new Uint8Array(await readBinaryFile(path));
  const task = pdfjsLib.getDocument({ data: bytes });
  try {
    return await contentsOf(await task.promise);
  } finally {
    await task.destroy();
  }
}
