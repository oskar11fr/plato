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

/** Every page's text of a workspace PDF (index 0 = page 1). */
export async function documentText(path: string): Promise<string[]> {
  const { pdfjsLib } = await loadPdfjs();
  const bytes = new Uint8Array(await readBinaryFile(path));
  const task = pdfjsLib.getDocument({ data: bytes });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) pages.push(await pageTextOf(doc, n));
    return pages;
  } finally {
    await task.destroy();
  }
}
