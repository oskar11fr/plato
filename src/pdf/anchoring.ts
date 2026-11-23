// Turns a DOM selection in a pdf.js text layer into a stable anchor
// (text offsets, quote/prefix/suffix, normalized rects) and back again.
import type { Rect } from "../lib/annotations";

const CONTEXT_CHARS = 32;

/** One text node or <br> of the text layer, at its offset in the page text. */
interface Segment {
  node: Node;
  start: number;
  length: number;
}

export interface PageText {
  text: string;
  segments: Segment[];
}

/** Page text as the text layer shows it: span text, with <br> as a newline. */
export function readPageText(textLayer: Element): PageText {
  const segments: Segment[] = [];
  let text = "";
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let piece: string | null = null;
    if (node.nodeType === Node.TEXT_NODE) piece = (node as Text).data;
    else if ((node as Element).tagName === "BR") piece = "\n";
    if (piece === null || piece.length === 0) continue;
    segments.push({ node, start: text.length, length: piece.length });
    text += piece;
  }
  return { text, segments };
}

/** Offset in the page text of a DOM boundary point inside the text layer. */
function offsetOf(page: PageText, container: Node, offset: number): number {
  if (container.nodeType === Node.TEXT_NODE) {
    const seg = page.segments.find((s) => s.node === container);
    if (seg) return seg.start + Math.min(offset, seg.length);
  }
  // Element boundary: the position of the first segment at or after it.
  const probe = document.createRange();
  probe.setStart(container, offset);
  for (const seg of page.segments) {
    if (probe.comparePoint(seg.node, 0) >= 0) return seg.start;
  }
  return page.text.length;
}

export function rangeToOffsets(page: PageText, range: Range): { start: number; end: number } {
  return {
    start: offsetOf(page, range.startContainer, range.startOffset),
    end: offsetOf(page, range.endContainer, range.endOffset),
  };
}

/** A DOM range over the page text from `start` to `end`. */
export function offsetsToRange(page: PageText, start: number, end: number): Range | null {
  const range = document.createRange();
  const place = (pos: number, setter: "setStart" | "setEnd") => {
    const seg = page.segments.find((s) => pos >= s.start && pos <= s.start + s.length);
    if (!seg) return false;
    if (seg.node.nodeType === Node.TEXT_NODE) range[setter](seg.node, pos - seg.start);
    else if (pos === seg.start) range[setter === "setStart" ? "setStartBefore" : "setEndBefore"](seg.node);
    else range[setter === "setStart" ? "setStartAfter" : "setEndAfter"](seg.node);
    return true;
  };
  return place(start, "setStart") && place(end, "setEnd") ? range : null;
}

export const normalizeSpace = (s: string) => s.replace(/\s+/g, " ").trim();

/** Quote and surrounding context for the text between two offsets. */
export function quoteAt(page: PageText, start: number, end: number) {
  return {
    quote: normalizeSpace(page.text.slice(start, end)),
    prefix: normalizeSpace(page.text.slice(Math.max(0, start - CONTEXT_CHARS), start)),
    suffix: normalizeSpace(page.text.slice(end, end + CONTEXT_CHARS)),
  };
}

/**
 * Rects of a range as fractions of the page box, merged so each line of
 * the selection becomes one rect.
 */
export function rangeRects(range: Range, pageBox: DOMRect): Rect[] {
  const lines: DOMRect[] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const line = lines.find((l) => sameLine(l, r));
    if (line) {
      const left = Math.min(line.left, r.left);
      const top = Math.min(line.top, r.top);
      const right = Math.max(line.right, r.right);
      const bottom = Math.max(line.bottom, r.bottom);
      lines[lines.indexOf(line)] = new DOMRect(left, top, right - left, bottom - top);
    } else {
      lines.push(r);
    }
  }
  const w = pageBox.width;
  const h = pageBox.height;
  return lines.map((r) => [
    round((r.left - pageBox.left) / w),
    round((r.top - pageBox.top) / h),
    round((r.right - pageBox.left) / w),
    round((r.bottom - pageBox.top) / h),
  ]);
}

/** Same text line: mostly overlapping vertically and touching horizontally. */
function sameLine(a: DOMRect, b: DOMRect) {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const minHeight = Math.min(a.height, b.height);
  const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
  return overlap > minHeight * 0.5 && gap < minHeight;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Find a quote in the page text, ignoring whitespace differences. When the
 * quote occurs more than once, prefix and suffix pick the best match.
 */
export function findQuote(
  text: string,
  quote: string,
  prefix = "",
  suffix = "",
): { start: number; end: number } | null {
  // Collapse whitespace while remembering each kept char's original index.
  let norm = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const isSpace = /\s/.test(text[i]);
    if (isSpace && (norm.length === 0 || norm.endsWith(" "))) continue;
    norm += isSpace ? " " : text[i];
    origin.push(i);
  }
  const q = normalizeSpace(quote);
  if (!q) return null;

  let best: { at: number; score: number } | null = null;
  for (let at = norm.indexOf(q); at !== -1; at = norm.indexOf(q, at + 1)) {
    const score =
      commonSuffix(norm.slice(0, at).trimEnd(), normalizeSpace(prefix)) +
      commonPrefix(norm.slice(at + q.length).trimStart(), normalizeSpace(suffix));
    if (!best || score > best.score) best = { at, score };
  }
  if (!best) return null;
  return { start: origin[best.at], end: origin[best.at + q.length - 1] + 1 };
}

function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
