import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  setCharacterSqueeze,
  PDFDict,
  PDFArray,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  type PDFFont,
  type PDFPage,
  type Color,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { getStroke } from "perfect-freehand";
import type { DocumentState, EditorObj } from "./types";
import { dataUrlToArrayBuffer } from "./loader";
import { repairFontProgram, type EmbeddedFontEntry } from "./fontRepair";
import { getFontProgram } from "./fontPrograms";
import { removeOriginalText } from "./textRemove";

function hexToRgb(hex: string): Color {
  const m = hex.replace("#", "");
  const n =
    m.length === 3
      ? m
          .split("")
          .map((c) => c + c)
          .join("")
      : m;
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

function pickFont(
  fonts: Record<string, PDFFont>,
  family: string,
  bold?: boolean,
  italic?: boolean,
): PDFFont {
  const f = family.toLowerCase();
  if (f.includes("courier") || f.includes("mono")) {
    if (bold && italic) return fonts.courierBoldOblique;
    if (bold) return fonts.courierBold;
    if (italic) return fonts.courierOblique;
    return fonts.courier;
  }
  // "serif" matches the generic fallback too, but not "sans-serif"
  const serif =
    f.includes("times") ||
    f.includes("georgia") ||
    f.includes("garamond") ||
    f.includes("book") ||
    f.replace(/sans-serif/g, "").includes("serif");
  if (serif) {
    if (bold && italic) return fonts.timesBoldItalic;
    if (bold) return fonts.timesBold;
    if (italic) return fonts.timesItalic;
    return fonts.times;
  }
  if (bold && italic) return fonts.helveticaBoldOblique;
  if (bold) return fonts.helveticaBold;
  if (italic) return fonts.helveticaOblique;
  return fonts.helvetica;
}

// Normalize font names for matching: drop "ABCDEF+" subset tags, trailing
// "-1234" disambiguation suffixes, case, and punctuation.
const normFontName = (s: string) =>
  s
    .replace(/^[A-Z]{6}\+/, "")
    .replace(/-\d+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Collect embedded font programs from the source PDF, keyed by normalized
// name, so edited text can be re-set in the original face. Only TrueType
// (FontFile2) and full OpenType (FontFile3/OpenType) programs are usable by
// fontkit; Type1 and bare-CFF fonts fall back to the standard fonts.
function collectEmbeddedFonts(srcPdf: PDFDocument): Map<string, EmbeddedFontEntry> {
  const out = new Map<string, EmbeddedFontEntry>();
  const addFont = (fontDict: PDFDict) => {
    const subtype = fontDict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
    let target = fontDict;
    if (subtype === "/Type0") {
      const desc = fontDict
        .lookupMaybe(PDFName.of("DescendantFonts"), PDFArray)
        ?.lookup(0, PDFDict);
      if (!desc) return;
      target = desc;
    }
    const descriptor = target.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
    if (!descriptor) return;
    let stream = descriptor.lookup(PDFName.of("FontFile2"));
    if (!(stream instanceof PDFRawStream)) {
      const ff3 = descriptor.lookup(PDFName.of("FontFile3"));
      if (ff3 instanceof PDFRawStream) {
        const st = ff3.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
        if (st === "/OpenType") stream = ff3;
      }
    }
    if (!(stream instanceof PDFRawStream)) return;
    const names = [
      fontDict.lookupMaybe(PDFName.of("BaseFont"), PDFName)?.decodeText(),
      target.lookupMaybe(PDFName.of("BaseFont"), PDFName)?.decodeText(),
      descriptor.lookupMaybe(PDFName.of("FontName"), PDFName)?.decodeText(),
    ];
    let entry: EmbeddedFontEntry | null = null;
    for (const n of names) {
      const key = n ? normFontName(n) : "";
      if (!key) continue;
      if (!entry) {
        try {
          entry = { bytes: decodePDFRawStream(stream).decode() };
        } catch {
          return;
        }
        // CID subsets omit cmap/name; keep the PDF's own char->glyph data so
        // repairFontProgram can synthesize the tables fontkit needs.
        const tu = fontDict.lookup(PDFName.of("ToUnicode"));
        if (tu instanceof PDFRawStream) {
          try {
            entry.toUnicode = new TextDecoder("latin1").decode(decodePDFRawStream(tu).decode());
          } catch {
            // unreadable ToUnicode; cmap synthesis just won't happen
          }
        }
        const c2g = target.lookup(PDFName.of("CIDToGIDMap"));
        if (c2g instanceof PDFRawStream) {
          try {
            entry.cidToGid = decodePDFRawStream(c2g).decode();
          } catch {
            // treat as identity
          }
        }
      }
      // Same face may be subset-embedded several times (one per page);
      // keep the largest program — bigger subset ≈ more glyph coverage.
      const prev = out.get(key);
      if (prev && prev.bytes.length >= entry.bytes.length) continue;
      out.set(key, entry);
    }
  };
  for (const page of srcPdf.getPages()) {
    try {
      const fontsDict = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
      if (!fontsDict) continue;
      for (const [key] of fontsDict.entries()) {
        try {
          const fontDict = fontsDict.lookupMaybe(key, PDFDict);
          if (fontDict) addFont(fontDict);
        } catch {
          // skip malformed font entry
        }
      }
    } catch {
      // skip malformed page resources
    }
  }
  return out;
}

// Candidate real names stored in the edit's CSS font stack, e.g.
// '"g_d0_f1", "TimesNewRomanPS-BoldMT", "Times New Roman", serif'
function fontStackNames(familyStr: string): string[] {
  return [...familyStr.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((n) => !/^g_d\d+_f\d+$/.test(n));
}

// pdf.js loaded-name in the stack ("g_d0_f1") — key into the registry of
// pdf.js-translated font programs captured while rendering.
function pdfjsNameFromStack(familyStr: string): string | null {
  return familyStr.match(/"(g_d\d+_f\d+)"/)?.[1] ?? null;
}

// Spaces are ignored: subset/pdf.js fonts often carry no space glyph (PDF
// viewers use word spacing instead), so spaced text is drawn word-by-word.
function fontCovers(font: PDFFont, text: string): boolean {
  try {
    const set = new Set(font.getCharacterSet());
    for (const ch of text) {
      if (ch === " ") continue;
      if (!set.has(ch.codePointAt(0)!)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function strokeToSvgPath(points: number[][]): string {
  if (!points.length) return "";
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)}`;
  }
  d += " Z";
  return d;
}

async function drawObjectsOnPage(
  page: PDFPage,
  objs: EditorObj[],
  pageW: number,
  pageH: number,
  fonts: Record<string, PDFFont>,
  pdfDoc: PDFDocument,
) {
  for (const o of objs) {
    // Convert 0..1 top-left coords -> pdf coords (bottom-left origin)
    const x = o.x * pageW;
    const w = o.w * pageW;
    const h = o.h * pageH;
    const y = pageH - o.y * pageH - h;

    if (o.type === "text") {
      const font = pickFont(fonts, o.font, o.bold, o.italic);
      const color = hexToRgb(o.color);
      const lines = o.content.split("\n");
      const lineHeight = o.size * 1.2;
      lines.forEach((line, i) => {
        page.drawText(line, {
          x,
          y: y + h - o.size - i * lineHeight,
          size: o.size,
          font,
          color,
        });
      });
    } else if (o.type === "rect") {
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        borderWidth: o.strokeWidth,
        borderColor: hexToRgb(o.stroke),
        color: o.fill === "none" ? undefined : hexToRgb(o.fill),
      });
    } else if (o.type === "ellipse") {
      page.drawEllipse({
        x: x + w / 2,
        y: y + h / 2,
        xScale: w / 2,
        yScale: h / 2,
        borderWidth: o.strokeWidth,
        borderColor: hexToRgb(o.stroke),
        color: o.fill === "none" ? undefined : hexToRgb(o.fill),
      });
    } else if (o.type === "line" || o.type === "arrow") {
      const start = { x, y: y + h };
      const end = { x: x + w, y };
      page.drawLine({
        start,
        end,
        thickness: o.strokeWidth,
        color: hexToRgb(o.stroke),
      });
      if (o.type === "arrow") {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const size = Math.max(6, o.strokeWidth * 3);
        const px = -uy;
        const py = ux;
        const p1 = {
          x: end.x - ux * size + px * size * 0.5,
          y: end.y - uy * size + py * size * 0.5,
        };
        const p2 = {
          x: end.x - ux * size - px * size * 0.5,
          y: end.y - uy * size - py * size * 0.5,
        };
        const d = `M ${end.x} ${end.y} L ${p1.x} ${p1.y} L ${p2.x} ${p2.y} Z`;
        page.drawSvgPath(d, { color: hexToRgb(o.stroke), borderWidth: 0 });
      }
    } else if (o.type === "highlight") {
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        color: hexToRgb(o.color),
        opacity: 0.35,
        borderWidth: 0,
      });
    } else if (o.type === "note") {
      // yellow sticky
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        color: hexToRgb(o.color),
        opacity: 0.9,
        borderWidth: 0.5,
        borderColor: rgb(0.8, 0.7, 0.2),
      });
      const font = fonts.helvetica;
      const size = 10;
      const lineHeight = size * 1.2;
      const padding = 4;
      const lines = o.content.split("\n");
      lines.forEach((line, i) => {
        page.drawText(line, {
          x: x + padding,
          y: y + h - padding - size - i * lineHeight,
          size,
          font,
          color: rgb(0.15, 0.15, 0.15),
          maxWidth: w - padding * 2,
        });
      });
    } else if (o.type === "image") {
      const ab = dataUrlToArrayBuffer(o.src);
      const img = o.mime.includes("png") ? await pdfDoc.embedPng(ab) : await pdfDoc.embedJpg(ab);
      page.drawImage(img, { x, y, width: w, height: h });
    } else if (o.type === "draw") {
      // Draw as connected line segments (bottom-left origin, y-up)
      const color = hexToRgb(o.color);
      const pts = o.points.map(([nx, ny]) => ({
        x: nx * pageW,
        y: pageH - ny * pageH,
      }));
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: pts[i - 1],
          end: pts[i],
          thickness: o.size,
          color,
          lineCap: 1, // round
        });
      }
    }
  }
}

export async function exportPdf(doc: DocumentState): Promise<Uint8Array> {
  const srcBytes = dataUrlToArrayBuffer(doc.fileDataUrl);
  // Edit the source document in place instead of rebuilding it: metadata
  // (Info + XMP), bookmarks, links, forms, and page structure all survive
  // untouched, so the output differs from the original only by the edits.
  const outPdf = await PDFDocument.load(srcBytes, { updateMetadata: false });
  outPdf.registerFontkit(fontkit);

  // Original embedded font programs, embedded into the output on demand
  const srcFontLib = collectEmbeddedFonts(outPdf);
  const embedCache = new Map<string, PDFFont | null>();
  const embedOriginal = async (familyStr: string): Promise<PDFFont | null> => {
    for (const rawName of fontStackNames(familyStr)) {
      const key = normFontName(rawName);
      if (embedCache.has(key)) {
        const cached = embedCache.get(key)!;
        if (cached) return cached;
        continue;
      }
      const entry = srcFontLib.get(key);
      if (!entry) continue;
      try {
        const f = await outPdf.embedFont(repairFontProgram(entry, rawName));
        embedCache.set(key, f);
        return f;
      } catch {
        embedCache.set(key, null); // unparseable program (e.g. bare CFF)
      }
    }
    return null;
  };

  // Font program translated by pdf.js while rendering — the exact face the
  // on-screen overlay used, valid for all embedded font types.
  const pdfjsCache = new Map<string, PDFFont | null>();
  const embedPdfjs = async (familyStr: string): Promise<PDFFont | null> => {
    const name = pdfjsNameFromStack(familyStr);
    if (!name) return null;
    if (pdfjsCache.has(name)) return pdfjsCache.get(name)!;
    let f: PDFFont | null = null;
    const data = getFontProgram(name);
    if (data) {
      try {
        f = await outPdf.embedFont(data);
      } catch {
        f = null;
      }
    }
    pdfjsCache.set(name, f);
    return f;
  };

  const fonts = {
    helvetica: await outPdf.embedFont(StandardFonts.Helvetica),
    helveticaBold: await outPdf.embedFont(StandardFonts.HelveticaBold),
    helveticaOblique: await outPdf.embedFont(StandardFonts.HelveticaOblique),
    helveticaBoldOblique: await outPdf.embedFont(StandardFonts.HelveticaBoldOblique),
    times: await outPdf.embedFont(StandardFonts.TimesRoman),
    timesBold: await outPdf.embedFont(StandardFonts.TimesRomanBold),
    timesItalic: await outPdf.embedFont(StandardFonts.TimesRomanItalic),
    timesBoldItalic: await outPdf.embedFont(StandardFonts.TimesRomanBoldItalic),
    courier: await outPdf.embedFont(StandardFonts.Courier),
    courierBold: await outPdf.embedFont(StandardFonts.CourierBold),
    courierOblique: await outPdf.embedFont(StandardFonts.CourierOblique),
    courierBoldOblique: await outPdf.embedFont(StandardFonts.CourierBoldOblique),
  } as const;

  // Restructure pages in place. The editor supports delete / insert-blank /
  // rotate but not reorder, so source order is preserved: drop removed
  // source pages, then slot blanks in at their positions.
  const keep = new Set(doc.pages.map((p) => p.sourceIndex).filter((v): v is number => v !== null));
  if (keep.size === 0) {
    // all-blank document: insert blanks first, then drop the source pages
    doc.pages.forEach((info, pos) => outPdf.insertPage(pos, [info.width, info.height]));
    for (let i = outPdf.getPageCount() - 1; i >= doc.pages.length; i--) outPdf.removePage(i);
  } else {
    for (let i = outPdf.getPageCount() - 1; i >= 0; i--) if (!keep.has(i)) outPdf.removePage(i);
    doc.pages.forEach((info, pos) => {
      if (info.sourceIndex === null) outPdf.insertPage(pos, [info.width, info.height]);
    });
  }

  for (let i = 0; i < doc.pages.length; i++) {
    const info = doc.pages[i];
    const page: PDFPage = outPdf.getPage(i);
    if (info.rotation) page.setRotation(degrees(info.rotation));
    const size = page.getSize();

    // 1) Cover + retype edited original text (before overlay objects)
    const edits = (doc.textEdits ?? []).filter((e) => e.page === i);

    // Delete the original show-text operators outright where that is
    // provably safe — the old text is then gone from the file instead of
    // hidden under a cover. Partial (per-color) segments keep the cover.
    const removable = new Map<string, number>();
    for (const e of edits) {
      if (!/^t\d+$/.test(e.key)) continue;
      removable.set(e.origStr, (removable.get(e.origStr) ?? 0) + 1);
    }
    const removed =
      info.sourceIndex !== null && removable.size
        ? removeOriginalText(outPdf, page, removable)
        : new Set<string>();
    for (const e of edits) {
      const px = e.x * size.width;
      const origPw = Math.max(e.w * size.width, e.fontSize * 0.6);
      const ph = Math.max(e.h * size.height, e.fontSize * 1.1);
      const py = size.height - e.y * size.height - ph;
      let font = pickFont(fonts, e.fontFamily, e.bold, e.italic);
      // Prefer the document's own embedded font — exact original face — when
      // its program is re-embeddable, it has glyphs for the new text, and the
      // user didn't override bold/italic away from the face's built-in style.
      const stackBlob = fontStackNames(e.fontFamily).join(" ").toLowerCase();
      const faceBold = /bold|black|heavy|semibold|demi/.test(stackBlob);
      const faceItalic = /italic|oblique/.test(stackBlob);
      if (e.bold === faceBold && e.italic === faceItalic) {
        for (const cand of [await embedPdfjs(e.fontFamily), await embedOriginal(e.fontFamily)]) {
          if (cand && fontCovers(cand, e.newStr)) {
            font = cand;
            break;
          }
        }
      }
      // Embedded faces may lack a space glyph — measure/draw word-by-word
      // then, advancing spaces by a standard space width.
      let coversSpace = true;
      try {
        coversSpace = font.getCharacterSet().includes(32);
      } catch {
        // standard fonts: WinAnsi always encodes the space
      }
      const spaceW = coversSpace
        ? font.widthOfTextAtSize(" ", e.fontSize)
        : fonts.helvetica.widthOfTextAtSize(" ", e.fontSize);
      const measureText = (t: string): number => {
        if (coversSpace) return font.widthOfTextAtSize(t, e.fontSize);
        const parts = t.split(" ");
        let w = (parts.length - 1) * spaceW;
        for (const p of parts) if (p) w += font.widthOfTextAtSize(p, e.fontSize);
        return w;
      };
      // Standard fonts use WinAnsi encoding; replace what they can't encode
      let text = e.newStr;
      let newTextW: number;
      try {
        newTextW = measureText(text);
      } catch {
        text = text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
        newTextW = measureText(text);
      }
      // Text within 12% of the original width snaps to it exactly (Tz) so
      // alignment stays pixel-perfect; longer text squeezes to stay inside
      // the original footprint — matches the on-screen behavior.
      const ratio =
        newTextW > 0 && Math.abs(newTextW - origPw) / origPw <= 0.12
          ? origPw / newTextW
          : newTextW > origPw
            ? Math.max(origPw / newTextW, 0.55)
            : 1;
      const coverW = Math.max(origPw, newTextW * ratio);
      // Cover only when the original operators couldn't be removed. The
      // extracted box stops at the baseline; extend the cover below it so
      // descenders of the original text ("g", "p", "y") don't ghost through.
      if (!(removed.has(e.origStr) && /^t\d+$/.test(e.key))) {
        const descent = e.fontSize * 0.25;
        page.drawRectangle({
          x: px - 1,
          y: py - descent,
          width: coverW + 2,
          height: ph + descent + 1,
          color: e.bgColor ? hexToRgb(e.bgColor) : rgb(1, 1, 1),
          borderWidth: 0,
        });
      }
      // Exact PDF baseline when recorded; legacy edits approximate from top.
      // dx/dy is the drag-to-move offset; the cover stays on the original.
      const textX = px + (e.dx ?? 0) * size.width;
      const dyPt = (e.dy ?? 0) * size.height;
      const baselineY =
        (e.baseline !== undefined
          ? size.height - e.baseline * size.height
          : size.height - e.y * size.height - e.fontSize) - dyPt;
      const color = e.color ? hexToRgb(e.color) : rgb(0, 0, 0);
      if (ratio < 1) page.pushOperators(setCharacterSqueeze(ratio * 100));
      if (coversSpace || !text.includes(" ")) {
        page.drawText(text, {
          x: textX,
          y: baselineY,
          size: e.fontSize,
          font,
          color,
        });
      } else {
        // No space glyph in the embedded face: draw word-by-word. Glyph
        // advances scale with the Tz squeeze; our manual positions must too.
        let cursor = 0;
        for (const part of text.split(" ")) {
          if (part) {
            page.drawText(part, {
              x: textX + cursor * ratio,
              y: baselineY,
              size: e.fontSize,
              font,
              color,
            });
            cursor += font.widthOfTextAtSize(part, e.fontSize);
          }
          cursor += spaceW;
        }
      }
      if (ratio < 1) page.pushOperators(setCharacterSqueeze(100));
      if (e.underline || e.strike) {
        const visualW = newTextW * ratio;
        const thickness = Math.max(0.5, e.fontSize * 0.06);
        const lineAt = (y: number) =>
          page.drawLine({
            start: { x: textX, y },
            end: { x: textX + visualW, y },
            thickness,
            color,
          });
        if (e.underline) lineAt(baselineY - e.fontSize * 0.12);
        if (e.strike) lineAt(baselineY + e.fontSize * 0.25);
      }
    }

    const objs = doc.objects.filter((o) => o.page === i);
    await drawObjectsOnPage(
      page,
      objs,
      size.width,
      size.height,
      fonts as Record<string, PDFFont>,
      outPdf,
    );
  }

  return outPdf.save();
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes.slice() as unknown as ArrayBuffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
