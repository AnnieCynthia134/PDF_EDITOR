// Extracts text items from a pdf.js page with normalized (0..1) top-left
// coordinates matching the rest of the editor overlay coordinate system.

import { getPdfJs } from "./pdfjs";
import { registerFontProgram } from "./fontPrograms";

export interface PdfTextItem {
  key: string; // stable per (page, item index [, color segment])
  str: string;
  x: number; // normalized top-left, 0..1
  y: number;
  w: number;
  h: number;
  baseline: number; // normalized y of the text baseline, 0..1
  fontSize: number; // PDF pt
  // CSS font stack: the pdf.js-loaded embedded face first (exact glyphs),
  // then the real family name, then the generic fallback.
  fontFamily: string;
  embedded: boolean; // true when the embedded pdf.js font face is available
  bold: boolean;
  italic: boolean;
  color: string; // hex color, e.g. "#000000"
  bgColor: string; // hex, page background behind the text
}

interface PdfjsTextItem {
  str: string;
  transform: number[]; // [a,b,c,d,e,f]
  width: number;
  height: number;
  fontName?: string; // pdf.js loaded name, e.g. "g_d0_f1"
}

interface PdfjsTextStyle {
  fontFamily?: string; // generic fallback: serif | sans-serif | monospace
  ascent?: number;
  descent?: number;
}

interface PdfjsPageLike {
  getTextContent: () => Promise<{
    items: PdfjsTextItem[];
    styles: Record<string, PdfjsTextStyle>;
  }>;
  getViewport: (opts: { scale: number; rotation?: number }) => {
    width: number;
    height: number;
    transform: number[];
  };
  commonObjs?: { get: (id: string) => unknown };
}

// Shared offscreen canvas for text measurement.
let measureCtx: CanvasRenderingContext2D | null = null;
export function measureTextWidth(
  text: string,
  family: string,
  sizePx: number,
  bold = false,
  italic = false,
): number {
  if (typeof document === "undefined" || !text) return 0;
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = `${italic ? "italic " : ""}${bold ? "700" : "400"} ${sizePx}px ${family}`;
  return measureCtx.measureText(text).width;
}

// Distance from the top of a CSS line box (line-height: 1) to the glyph
// baseline for the given font — lets overlay text sit on the exact PDF
// baseline instead of an approximated top edge.
export function domBaselineOffset(
  family: string,
  sizePx: number,
  bold = false,
  italic = false,
): number | null {
  if (typeof document === "undefined") return null;
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return null;
  measureCtx.font = `${italic ? "italic " : ""}${bold ? "700" : "400"} ${sizePx}px ${family}`;
  const m = measureCtx.measureText("Hg");
  const a = m.fontBoundingBoxAscent;
  const d = m.fontBoundingBoxDescent;
  if (a === undefined || d === undefined) return null;
  // CSS half-leading: baseline = halfLeading + ascent
  return (sizePx - (a + d)) / 2 + a;
}

// pdf.js registers embedded fonts in document.fonts under their loadedName
// (e.g. "g_d0_f1") while rendering the page to canvas. If that face exists we
// can render overlay text with the exact original glyphs.
function fontFaceAvailable(loadedName: string): boolean {
  if (!loadedName) return false;
  try {
    let found = false;
    document.fonts.forEach((f) => {
      if (f.family.replace(/['"]/g, "") === loadedName) found = true;
    });
    return found;
  } catch {
    return false;
  }
}

// "ABCDEF+TimesNewRomanPS-BoldMT" -> real name "TimesNewRomanPS-BoldMT"
function parseRealFontName(
  pdfPage: PdfjsPageLike,
  loadedName: string,
  cache: Map<string, string>,
): string {
  if (cache.has(loadedName)) return cache.get(loadedName)!;
  let real = "";
  try {
    const fontObj = pdfPage.commonObjs?.get(loadedName) as
      { name?: string; data?: Uint8Array } | undefined;
    real = (fontObj?.name || "").replace(/^[A-Z]{6}\+/, "");
    // Keep the pdf.js-translated program so the exporter can re-embed the
    // exact face the overlay renders with (works for all font types).
    registerFontProgram(loadedName, fontObj?.data);
  } catch {
    // font object not resolved yet; fall back to generic family
  }
  cache.set(loadedName, real);
  return real;
}

// "TimesNewRomanPS-BoldMT" -> CSS-friendly base family "Times New Roman"
function baseFamilyFromRealName(real: string): string {
  if (!real) return "";
  return real
    .split(/[-,]/)[0]
    .replace(/(PSMT|PS|MT|Std|Pro)$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

// ---------------------------------------------------------------------------
// Canvas color sampling.
// ponytail: text/background colors sampled from the rendered canvas — pdf.js
// getTextContent carries no color info. Assumes a mostly solid background;
// parse the page operator list instead if this mis-samples on busy artwork.
// ---------------------------------------------------------------------------

interface Region {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function grabRegion(
  canvas: HTMLCanvasElement,
  nx: number,
  ny: number,
  nw: number,
  nh: number,
): Region | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const x = Math.max(0, Math.floor(nx * canvas.width));
  const y = Math.max(0, Math.floor(ny * canvas.height));
  const w = Math.min(canvas.width - x, Math.max(2, Math.ceil(nw * canvas.width)));
  const h = Math.min(canvas.height - y, Math.max(2, Math.ceil(nh * canvas.height)));
  if (w < 2 || h < 2) return null;
  try {
    return { data: ctx.getImageData(x, y, w, h).data, w, h };
  } catch {
    return null;
  }
}

const keyToRgb = (k: number): [number, number, number] => [
  ((k >> 8) & 15) * 17,
  ((k >> 4) & 15) * 17,
  (k & 15) * 17,
];
const keyToHex = (k: number) =>
  "#" +
  keyToRgb(k)
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");
const rgbDist = (a: [number, number, number], b: [number, number, number]) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

// Histogram of quantized colors (16 levels/channel) over columns [x0, x1)
function histo(region: Region, x0: number, x1: number): Map<number, number> {
  const { data, w, h } = region;
  const from = Math.max(0, Math.min(x0, w - 1));
  const to = Math.max(from + 1, Math.min(x1, w));
  const counts = new Map<number, number>();
  const step = Math.max(1, Math.floor(((to - from) * h) / 20000));
  let n = 0;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = from; xx < to; xx++) {
      if (step > 1 && n++ % step) continue;
      const o = (yy * w + xx) * 4;
      const key = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

// Exact color: average the full-precision pixels near the winning histogram
// bucket — removes the 16-level quantization error so covers and retyped
// text match the original colors exactly.
function meanColorNear(
  region: Region,
  x0: number,
  x1: number,
  target: [number, number, number],
  maxDist: number,
): string | null {
  const { data, w, h } = region;
  const from = Math.max(0, Math.min(x0, w - 1));
  const to = Math.max(from + 1, Math.min(x1, w));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(((to - from) * h) / 20000));
  let k = 0;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = from; xx < to; xx++) {
      if (step > 1 && k++ % step) continue;
      const o = (yy * w + xx) * 4;
      if (rgbDist([data[o], data[o + 1], data[o + 2]], target) > maxDist) continue;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  if (!n) return null;
  const hex = (v: number) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Text color: the bucket that is both frequent and far from the background
// (anti-aliased edge pixels are frequent but sit near the background color).
function pickTextColor(
  counts: Map<number, number>,
  bgKey: number,
): { key: number; strength: number } | null {
  const bgRgb = keyToRgb(bgKey);
  let bestKey = -1;
  let bestScore = 0;
  let strength = 0;
  for (const [k, c] of counts) {
    if (k === bgKey) continue;
    const d = rgbDist(keyToRgb(k), bgRgb);
    if (d > 48) strength += c;
    const score = c * d * d;
    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
    }
  }
  return bestKey === -1 ? null : { key: bestKey, strength };
}

// Detect per-character color runs so a partially-colored word can be edited
// per color. Returns null when there is a single color or sampling is noisy.
function splitColorRuns(
  str: string,
  region: Region,
  bgKey: number,
  family: string,
  bold: boolean,
  italic: boolean,
): Array<{ from: number; to: number; color: string }> | null {
  if (str.length < 2 || str.length > 80 || bgKey < 0) return null;
  const total = measureTextWidth(str, family, 100, bold, italic);
  if (!total) return null;
  // Character boundaries in region pixels (proportional to measured widths)
  const bounds: number[] = [0];
  for (let k = 1; k <= str.length; k++) {
    bounds.push(
      Math.round((measureTextWidth(str.slice(0, k), family, 100, bold, italic) / total) * region.w),
    );
  }
  const colors: (number | null)[] = [];
  for (let k = 0; k < str.length; k++) {
    const t = pickTextColor(
      histo(region, bounds[k], Math.max(bounds[k + 1], bounds[k] + 1)),
      bgKey,
    );
    // Weak slices (spaces, thin glyphs) inherit a neighbor color below
    colors.push(t && t.strength >= 4 ? t.key : null);
  }
  for (let k = 1; k < colors.length; k++) if (colors[k] === null) colors[k] = colors[k - 1];
  for (let k = colors.length - 2; k >= 0; k--) if (colors[k] === null) colors[k] = colors[k + 1];
  if (colors[0] === null) return null;
  const runs: { from: number; to: number; key: number }[] = [{ from: 0, to: 1, key: colors[0]! }];
  for (let k = 1; k < str.length; k++) {
    const cur = runs[runs.length - 1];
    if (rgbDist(keyToRgb(colors[k]!), keyToRgb(cur.key)) <= 96) cur.to = k + 1;
    else runs.push({ from: k, to: k + 1, key: colors[k]! });
  }
  if (runs.length < 2 || runs.length > 6) return null; // single color, or noise
  return runs.map((r) => ({
    from: r.from,
    to: r.to,
    color:
      meanColorNear(region, bounds[r.from], bounds[r.to], keyToRgb(r.key), 48) ?? keyToHex(r.key),
  }));
}

// ---------------------------------------------------------------------------

// Text items are already in the unrotated PDF space (we pass rotation:0 to
// the viewport). Downstream overlay/exporter also work in unrotated coords.
export async function extractPageText(
  pdfPage: PdfjsPageLike,
  canvas?: HTMLCanvasElement | null,
): Promise<PdfTextItem[]> {
  const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
  const pageW = viewport.width;
  const pageH = viewport.height;
  const content = await pdfPage.getTextContent();
  const pdfjs = await getPdfJs();
  const Util = (pdfjs as unknown as { Util: { transform: (a: number[], b: number[]) => number[] } })
    .Util;

  const realNameCache = new Map<string, string>();
  const items: PdfTextItem[] = [];
  content.items.forEach((it, i) => {
    if (!it.str) return;
    if (!it.str.replace(/\s+/g, "")) return;
    const t = Util.transform(viewport.transform, it.transform);
    const fontSize =
      Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[3]) || 12;
    const height = it.height || fontSize;
    const width = it.width || it.str.length * fontSize * 0.5;
    const cx = t[4];
    const cy = t[5] - height; // top edge in canvas coords
    const loadedName = it.fontName || "";
    const style = (content.styles || {})[loadedName] || {};
    const fallback = (style.fontFamily || "sans-serif").toString();
    const realName = parseRealFontName(pdfPage, loadedName, realNameCache);
    const baseFamily = baseFamilyFromRealName(realName);
    const embedded = fontFaceAvailable(loadedName);
    const stack: string[] = [];
    if (embedded) stack.push(`"${loadedName}"`);
    if (realName) stack.push(`"${realName}"`);
    if (baseFamily && baseFamily !== realName) stack.push(`"${baseFamily}"`);
    stack.push(fallback);
    const cssFamily = stack.join(", ");
    const nameBlob = `${realName} ${fallback}`.toLowerCase();
    const bold = /bold|black|heavy|semibold|demi/.test(nameBlob);
    const italic = /italic|oblique/.test(nameBlob);
    const nx = cx / pageW;
    const ny = cy / pageH;
    const nw = width / pageW;
    const nh = height / pageH;

    // Sample colors from the rendered canvas
    const region = canvas ? grabRegion(canvas, nx, ny, nw, nh) : null;
    let color = "#000000";
    let bgColor = "#ffffff";
    let bgKey = -1;
    if (region) {
      const counts = histo(region, 0, region.w);
      if (counts.size) {
        bgKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        bgColor = meanColorNear(region, 0, region.w, keyToRgb(bgKey), 30) ?? keyToHex(bgKey);
        const picked = pickTextColor(counts, bgKey);
        if (picked)
          color =
            meanColorNear(region, 0, region.w, keyToRgb(picked.key), 48) ?? keyToHex(picked.key);
      }
    }

    const base = {
      y: ny,
      h: nh,
      baseline: t[5] / pageH,
      fontSize,
      fontFamily: cssFamily,
      embedded,
      bold,
      italic,
      bgColor,
    };

    // Multi-color runs become independently editable segments
    const measureBold = bold && !embedded;
    const measureItalic = italic && !embedded;
    const runs = region
      ? splitColorRuns(it.str, region, bgKey, cssFamily, measureBold, measureItalic)
      : null;
    if (runs) {
      const total = measureTextWidth(it.str, cssFamily, 100, measureBold, measureItalic);
      runs.forEach((r, j) => {
        const x0 =
          measureTextWidth(it.str.slice(0, r.from), cssFamily, 100, measureBold, measureItalic) /
          total;
        const x1 =
          measureTextWidth(it.str.slice(0, r.to), cssFamily, 100, measureBold, measureItalic) /
          total;
        items.push({
          ...base,
          key: `t${i}s${j}`,
          str: it.str.slice(r.from, r.to),
          x: nx + x0 * nw,
          w: (x1 - x0) * nw,
          color: r.color,
        });
      });
      return;
    }

    items.push({ ...base, key: `t${i}`, str: it.str, x: nx, w: nw, color });
  });
  return items;
}
