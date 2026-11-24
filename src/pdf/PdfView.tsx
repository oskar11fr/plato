import "pdfjs-dist/web/pdf_viewer.css";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  loadAnnotations,
  newHighlightId,
  saveAnnotations,
  sha256,
  type AnnotationFile,
  type Highlight,
} from "../lib/annotations";
import { readBinaryFile } from "../lib/backend";
import {
  findQuote,
  normalizeSpace,
  offsetsToRange,
  quoteAt,
  rangeRects,
  rangeToOffsets,
  readPageText,
} from "./anchoring";
import { revealHighlight } from "../lib/bus";
import { findChatForHighlight } from "../lib/chats";
import { loadPdfjs } from "./pdfjs";

interface Props {
  path: string;
  /** Ask AI about a highlight; `pageText` is the full text of its page. */
  onAskAi: (highlight: Highlight, pageText: string) => void;
  onOpenChat: () => void;
  /** Open a saved chat (one that discusses a clicked highlight). */
  onShowChat: (chatPath: string) => void;
}

/** A single-page text selection waiting for Highlight / Ask AI. */
interface PendingSelection {
  page: number;
  start: number;
  end: number;
  x: number;
  y: number;
}

interface Popover {
  id: string;
  x: number;
  y: number;
  /** A saved chat that discusses this highlight (looked up on click). */
  chatPath?: string | null;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

export function PdfView({ path, onAskAi, onOpenChat, onShowChat }: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const store = useRef<AnnotationFile | null>(null);
  const fitWidth = useRef(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [detached, setDetached] = useState(0);
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);

  // Load the document and its annotations, and wire pdf.js events.
  useEffect(() => {
    const container = containerRef.current!;
    const viewerDiv = viewerRef.current!;
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let pdfViewer: PDFViewer | null = null;
    setLoading(true);
    setError(null);
    setSelection(null);
    setPopover(null);

    (async () => {
      const { pdfjsLib, viewerLib } = await loadPdfjs();
      const [buffer, annotations] = await Promise.all([readBinaryFile(path), loadAnnotations(path)]);
      const bytes = new Uint8Array(buffer);
      const hash = await sha256(bytes);
      if (cancelled) return;

      // If the file changed since the highlights were made, their rects may be
      // stale: re-find each quote once its page's text layer is rendered.
      const pagesToReanchor = new Set<number>();
      if (!annotations.fileHash) annotations.fileHash = hash;
      else if (annotations.fileHash !== hash) annotations.highlights.forEach((h) => pagesToReanchor.add(h.page));
      store.current = annotations;
      setDetached(countDetached(annotations));

      const eventBus = new viewerLib.EventBus();
      const linkService = new viewerLib.PDFLinkService({ eventBus });
      pdfViewer = new viewerLib.PDFViewer({ container, viewer: viewerDiv, eventBus, linkService });
      linkService.setViewer(pdfViewer);
      viewer.current = pdfViewer;
      const v = pdfViewer;

      eventBus.on("pagesinit", () => {
        v.currentScaleValue = "page-width";
      });
      eventBus.on("scalechanging", ({ scale }: { scale: number }) => setScale(scale));
      eventBus.on("pagerendered", ({ pageNumber }: { pageNumber: number }) => {
        if (store.current) drawHighlights(v, pageNumber, store.current.highlights);
      });
      eventBus.on("textlayerrendered", ({ pageNumber }: { pageNumber: number }) => {
        const s = store.current;
        if (!s || !pagesToReanchor.delete(pageNumber)) return;
        reanchorPage(v, pageNumber, s);
        if (pagesToReanchor.size === 0) s.fileHash = hash;
        drawHighlights(v, pageNumber, s.highlights);
        setDetached(countDetached(s));
        saveAnnotations(s).catch((e) => setError(String(e)));
      });

      loadingTask = pdfjsLib.getDocument({ data: bytes });
      const doc = await loadingTask.promise;
      if (cancelled) return;
      v.setDocument(doc);
      linkService.setDocument(doc);
      setLoading(false);
    })().catch((e) => {
      if (cancelled) return;
      setError(String(e));
      setLoading(false);
    });

    return () => {
      cancelled = true;
      viewer.current = null;
      store.current = null;
      pdfViewer?.setDocument(null as never);
      loadingTask?.destroy();
      viewerDiv.replaceChildren();
    };
  }, [path]);

  // Keep "fit width" fitted when the pane is resized.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const v = viewer.current;
      if (v && fitWidth.current && v.pagesCount > 0) v.currentScaleValue = "page-width";
    });
    observer.observe(containerRef.current!);
    return () => observer.disconnect();
  }, []);

  // Scroll to a highlight when the chat asks for it (clicking a quote).
  useEffect(() => {
    if (loading) return;
    return revealHighlight.subscribe(path, ({ highlightId, page }) => {
      const v = viewer.current;
      const h = store.current?.highlights.find((x) => x.id === highlightId);
      if (!v) return;
      v.scrollPageIntoView({ pageNumber: h?.page ?? page });
      flashHighlight(containerRef.current!, highlightId);
    });
  }, [path, loading]);

  /** Ask AI with the highlight's full page text as context. */
  async function askAi(h: Highlight) {
    const v = viewer.current;
    const text = v ? await pageText(v, h.page).catch(() => "") : "";
    onAskAi(h, text);
  }

  function persist() {
    if (store.current) saveAnnotations(store.current).catch((e) => setError(String(e)));
  }

  function paneOffset(clientX: number, clientY: number) {
    const box = paneRef.current!.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  }

  function onPointerUp() {
    // Read the selection after the browser has finished updating it.
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setSelection(null);
      const range = sel.getRangeAt(0);
      const layer = textLayerOf(range.startContainer);
      // Highlights live on one page; selections across pages are ignored.
      if (!layer || layer !== textLayerOf(range.endContainer)) return setSelection(null);
      const page = readPageText(layer);
      const { start, end } = rangeToOffsets(page, range);
      if (end <= start || !normalizeSpace(page.text.slice(start, end))) return setSelection(null);
      const box = range.getBoundingClientRect();
      setPopover(null);
      setSelection({
        page: pageNumberOf(layer),
        start,
        end,
        ...paneOffset(box.left + box.width / 2, box.top),
      });
    });
  }

  function createHighlight(): Highlight | null {
    const v = viewer.current;
    const s = store.current;
    if (!v || !s || !selection) return null;
    const layer = v.getPageView(selection.page - 1)?.textLayer?.div as HTMLElement | undefined;
    if (!layer) return null;
    const page = readPageText(layer);
    const range = offsetsToRange(page, selection.start, selection.end);
    if (!range) return null;
    const highlight: Highlight = {
      id: newHighlightId(),
      page: selection.page,
      ...quoteAt(page, selection.start, selection.end),
      rects: rangeRects(range, pageBox(layer)),
      color: "yellow",
      chatTurn: null,
      created: new Date().toISOString(),
    };
    s.highlights.push(highlight);
    persist();
    drawHighlights(v, highlight.page, s.highlights);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    return highlight;
  }

  function onClick(e: MouseEvent) {
    if (!window.getSelection()?.isCollapsed) return;
    const s = store.current;
    const pageDiv = (e.target as Element).closest<HTMLElement>(".page");
    if (!s || !pageDiv) return setPopover(null);
    const box = pageBox(pageDiv);
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    const pageNumber = Number(pageDiv.dataset.pageNumber);
    const hit = s.highlights.find(
      (h) =>
        h.page === pageNumber &&
        !h.detached &&
        h.rects.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1),
    );
    if (!hit) return setPopover(null);
    setPopover({ id: hit.id, ...paneOffset(e.clientX, e.clientY) });
    findChatForHighlight(path, hit.id).then(
      (chatPath) => setPopover((p) => (p?.id === hit.id ? { ...p, chatPath } : p)),
      () => {},
    );
  }

  function deleteHighlight(id: string) {
    const v = viewer.current;
    const s = store.current;
    if (!v || !s) return;
    const h = s.highlights.find((x) => x.id === id);
    s.highlights = s.highlights.filter((x) => x.id !== id);
    persist();
    if (h) drawHighlights(v, h.page, s.highlights);
    setDetached(countDetached(s));
    setPopover(null);
  }

  function zoom(factor: number) {
    const v = viewer.current;
    if (!v) return;
    fitWidth.current = false;
    v.currentScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.currentScale * factor));
  }

  function fit() {
    const v = viewer.current;
    if (!v) return;
    fitWidth.current = true;
    v.currentScaleValue = "page-width";
  }

  const popoverHighlight = popover && store.current?.highlights.find((h) => h.id === popover.id);

  return (
    <div className="pdf-pane" ref={paneRef}>
      <div className="pdf-toolbar">
        <button onClick={() => zoom(1 / 1.2)} title="Zoom out">
          −
        </button>
        <span className="pdf-scale">{Math.round(scale * 100)}%</span>
        <button onClick={() => zoom(1.2)} title="Zoom in">
          +
        </button>
        <button onClick={fit} title="Fit width">
          Fit
        </button>
        <span className="spacer" />
        {detached > 0 && (
          <span className="pdf-warning" title="The file changed and these quotes were not found again">
            {detached} highlight{detached === 1 ? "" : "s"} not found
          </span>
        )}
        <button onClick={onOpenChat}>Chat</button>
      </div>
      <div
        className="pdf-scroll"
        ref={containerRef}
        onPointerUp={onPointerUp}
        onClick={onClick}
        onScroll={() => {
          setSelection(null);
          setPopover(null);
        }}
      >
        <div className="pdfViewer" ref={viewerRef} />
      </div>
      {loading && <div className="pdf-overlay">Loading…</div>}
      {error && <div className="pdf-overlay error">{error}</div>}
      {selection && (
        <div className="floating-menu" style={{ left: selection.x, top: selection.y }}>
          <button onClick={createHighlight}>Highlight</button>
          <button
            onClick={() => {
              const h = createHighlight();
              if (h) void askAi(h);
            }}
          >
            Ask AI
          </button>
        </div>
      )}
      {popover && popoverHighlight && (
        <div className="floating-menu" style={{ left: popover.x, top: popover.y }}>
          <button
            onClick={() => {
              setPopover(null);
              void askAi(popoverHighlight);
            }}
          >
            Ask AI
          </button>
          {popover.chatPath && (
            <button
              onClick={() => {
                setPopover(null);
                onShowChat(popover.chatPath!);
              }}
            >
              Show in chat
            </button>
          )}
          <button onClick={() => deleteHighlight(popover.id)}>Delete</button>
        </div>
      )}
    </div>
  );
}

const textLayerOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".textLayer") ?? null;

const pageNumberOf = (layer: Element) =>
  Number(layer.closest<HTMLElement>(".page")?.dataset.pageNumber);

/**
 * The rendered page area (the page div's content box, inside its border).
 * Rects are fractions of this box. The text layer's own box is not used: it
 * can be larger than the page.
 */
function pageBox(inside: Element): DOMRect {
  const page = inside.closest<HTMLElement>(".page")!;
  const r = page.getBoundingClientRect();
  return new DOMRect(r.left + page.clientLeft, r.top + page.clientTop, page.clientWidth, page.clientHeight);
}

const countDetached = (s: AnnotationFile) => s.highlights.filter((h) => h.detached).length;

const pct = (n: number) => `${n * 100}%`;

/** A page's text from pdf.js, with line breaks where the PDF has them. */
async function pageText(viewer: PDFViewer, pageNumber: number): Promise<string> {
  const doc = viewer.pdfDocument;
  if (!doc) return "";
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Scroll a highlight into view once its page is drawn, and flash it. */
function flashHighlight(container: HTMLElement, id: string, tries = 40) {
  const els = container.querySelectorAll<HTMLElement>(`.plato-hl[data-id="${CSS.escape(id)}"]`);
  if (els.length === 0) {
    if (tries > 0) requestAnimationFrame(() => flashHighlight(container, id, tries - 1));
    return;
  }
  els[0].scrollIntoView({ block: "center", behavior: "smooth" });
  els.forEach((el) => {
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("flash");
  });
}

/** (Re)draw one page's highlights. pdf.js clears unknown layers on re-render. */
function drawHighlights(viewer: PDFViewer, pageNumber: number, highlights: Highlight[]) {
  const pageDiv: HTMLDivElement | undefined = viewer.getPageView(pageNumber - 1)?.div;
  if (!pageDiv) return;
  pageDiv.querySelector(":scope > .plato-hl-layer")?.remove();
  const onPage = highlights.filter((h) => h.page === pageNumber && !h.detached);
  if (onPage.length === 0) return;
  const layer = document.createElement("div");
  layer.className = "plato-hl-layer";
  for (const h of onPage) {
    for (const [x0, y0, x1, y1] of h.rects) {
      const el = document.createElement("div");
      el.className = `plato-hl plato-hl-${h.color}`;
      el.dataset.id = h.id;
      Object.assign(el.style, { left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0) });
      layer.append(el);
    }
  }
  pageDiv.append(layer);
}

/** Re-find a page's highlights by quote after the file changed. */
function reanchorPage(viewer: PDFViewer, pageNumber: number, store: AnnotationFile) {
  const layer = viewer.getPageView(pageNumber - 1)?.textLayer?.div as HTMLElement | undefined;
  if (!layer) return;
  const page = readPageText(layer);
  const box = pageBox(layer);
  for (const h of store.highlights) {
    if (h.page !== pageNumber) continue;
    const found = findQuote(page.text, h.quote, h.prefix, h.suffix);
    const range = found && offsetsToRange(page, found.start, found.end);
    if (range) {
      h.rects = rangeRects(range, box);
      delete h.detached;
    } else {
      h.detached = true;
    }
  }
}
