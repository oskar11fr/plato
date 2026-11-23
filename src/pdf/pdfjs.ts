// pdf.js's viewer module reads the core library from `globalThis.pdfjsLib`,
// so the core must be loaded and published before the viewer is imported.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type PdfjsLib = typeof import("pdfjs-dist");
type ViewerLib = typeof import("pdfjs-dist/web/pdf_viewer.mjs");

let loaded: Promise<{ pdfjsLib: PdfjsLib; viewerLib: ViewerLib }> | null = null;

export function loadPdfjs() {
  loaded ??= (async () => {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    (globalThis as { pdfjsLib?: PdfjsLib }).pdfjsLib = pdfjsLib;
    const viewerLib = await import("pdfjs-dist/web/pdf_viewer.mjs");
    return { pdfjsLib, viewerLib };
  })();
  return loaded;
}
