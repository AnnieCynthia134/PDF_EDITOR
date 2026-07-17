// Lazy client-only pdfjs loader. Never import pdfjs-dist at module scope
// because it references browser globals (DOMMatrix, Path2D) that break SSR.

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

export function getPdfJs(): Promise<PdfJs> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("pdfjs is browser-only"));
  }
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export async function loadPdf(data: ArrayBuffer) {
  const pdfjs = await getPdfJs();
  // fontExtraProperties keeps translated font programs on commonObjs so the
  // exporter can re-embed the exact faces the overlay renders with.
  return pdfjs.getDocument({ data, fontExtraProperties: true }).promise;
}
