import { nanoid } from "nanoid";
import { loadPdf } from "./pdfjs";
import type { DocumentState, PageInfo } from "./types";

export async function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

export function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function buildDocumentFromFile(file: File): Promise<DocumentState> {
  const dataUrl = await fileToDataUrl(file);
  const ab = dataUrlToArrayBuffer(dataUrl);
  // pdf.js consumes the buffer; clone for safety
  const doc = await loadPdf(ab.slice(0));
  const pages: PageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1, rotation: 0 });
    pages.push({
      id: nanoid(6),
      sourceIndex: i - 1,
      rotation: 0,
      width: vp.width,
      height: vp.height,
    });
  }
  return {
    fileName: file.name,
    fileDataUrl: dataUrl,
    pages,
    objects: [],
    textEdits: [],
  };
}
