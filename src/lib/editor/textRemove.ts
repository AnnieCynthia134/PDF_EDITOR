// Removes the original show-text operators of edited items from a page's
// content stream, so the old text is truly gone from the file (text
// selection, search, and extraction see only the replacement) instead of
// merely being painted over.
//
// Safety model: an operator is only blanked when its decoded text matches an
// edited string, the number of matching operators equals the number of edits
// wanting that string, and removing it cannot shift neighbouring text (the
// next show operator is preceded by absolute positioning). Anything
// ambiguous is left untouched — the caller then falls back to the cover
// rectangle, which is the previous behaviour.

import {
  PDFDocument,
  PDFPage,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import { parseToUnicode } from "./fontRepair";

// --- tokenizer ------------------------------------------------------------

interface Tok {
  kind: "str" | "num" | "name" | "op" | "arrOpen" | "arrClose" | "dictOpen" | "dictClose";
  start: number;
  end: number;
  bytes?: number[]; // decoded string bytes
  text?: string; // name / operator text
}

const isWS = (c: number) =>
  c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) =>
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;

function tokenize(b: Uint8Array): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (isWS(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      // % comment
      while (i < n && b[i] !== 0x0a && b[i] !== 0x0d) i++;
      continue;
    }
    const start = i;
    if (c === 0x28) {
      // ( literal string
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = b[i];
        if (ch === 0x5c) {
          // backslash escape
          const e = b[i + 1];
          if (e === 0x6e) bytes.push(10);
          else if (e === 0x72) bytes.push(13);
          else if (e === 0x74) bytes.push(9);
          else if (e === 0x62) bytes.push(8);
          else if (e === 0x66) bytes.push(12);
          else if (e >= 0x30 && e <= 0x37) {
            let oct = 0;
            let k = 0;
            while (k < 3 && b[i + 1 + k] >= 0x30 && b[i + 1 + k] <= 0x37) {
              oct = oct * 8 + (b[i + 1 + k] - 0x30);
              k++;
            }
            bytes.push(oct & 0xff);
            i += k - 1;
          } else if (e === 0x0a || e === 0x0d) {
            if (e === 0x0d && b[i + 2] === 0x0a) i++;
          } else bytes.push(e);
          i += 2;
          continue;
        }
        if (ch === 0x28) depth++;
        else if (ch === 0x29) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        bytes.push(ch);
        i++;
      }
      toks.push({ kind: "str", start, end: i, bytes });
      continue;
    }
    if (c === 0x3c) {
      if (b[i + 1] === 0x3c) {
        toks.push({ kind: "dictOpen", start, end: i + 2 });
        i += 2;
        continue;
      }
      // hex string
      const bytes: number[] = [];
      i++;
      let hi = -1;
      while (i < n && b[i] !== 0x3e) {
        const h = parseInt(String.fromCharCode(b[i]), 16);
        if (!Number.isNaN(h)) {
          if (hi < 0) hi = h;
          else {
            bytes.push(hi * 16 + h);
            hi = -1;
          }
        }
        i++;
      }
      if (hi >= 0) bytes.push(hi * 16);
      i++;
      toks.push({ kind: "str", start, end: i, bytes });
      continue;
    }
    if (c === 0x3e && b[i + 1] === 0x3e) {
      toks.push({ kind: "dictClose", start, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === 0x5b) {
      toks.push({ kind: "arrOpen", start, end: ++i });
      continue;
    }
    if (c === 0x5d) {
      toks.push({ kind: "arrClose", start, end: ++i });
      continue;
    }
    if (c === 0x2f) {
      // /Name (with #xx escapes)
      i++;
      let name = "";
      while (i < n && !isWS(b[i]) && !isDelim(b[i])) {
        if (b[i] === 0x23) {
          name += String.fromCharCode(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16));
          i += 3;
        } else name += String.fromCharCode(b[i++]);
      }
      toks.push({ kind: "name", start, end: i, text: name });
      continue;
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      i++;
      while (i < n && !isWS(b[i]) && !isDelim(b[i])) i++;
      toks.push({ kind: "num", start, end: i });
      continue;
    }
    // operator
    i++;
    while (i < n && !isWS(b[i]) && !isDelim(b[i])) i++;
    const text = String.fromCharCode(...b.subarray(start, i));
    toks.push({ kind: "op", start, end: i, text });
    if (text === "ID") {
      // inline image binary data: skip until whitespace + "EI"
      while (i < n) {
        if (
          isWS(b[i]) &&
          b[i + 1] === 0x45 &&
          b[i + 2] === 0x49 &&
          (i + 3 >= n || isWS(b[i + 3]) || isDelim(b[i + 3]))
        ) {
          toks.push({ kind: "op", start: i + 1, end: i + 3, text: "EI" });
          i += 3;
          break;
        }
        i++;
      }
    }
  }
  return toks;
}

// --- font decoders ----------------------------------------------------------

// cp1252 high range (rest matches latin-1)
const CP1252: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

type Decoder = (bytes: number[]) => string | null;

function buildDecoders(page: PDFPage): Map<string, Decoder> {
  const out = new Map<string, Decoder>();
  const fontsDict = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fontsDict) return out;
  for (const [key] of fontsDict.entries()) {
    try {
      const fd = fontsDict.lookupMaybe(key, PDFDict);
      if (!fd) continue;
      const subtype = fd.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
      const type0 = subtype === "/Type0";
      let toUni: Map<number, number> | null = null;
      const tu = fd.lookup(PDFName.of("ToUnicode"));
      if (tu instanceof PDFRawStream) {
        toUni = parseToUnicode(new TextDecoder("latin1").decode(decodePDFRawStream(tu).decode()));
      }
      out.set(key.decodeText(), (bytes) => {
        let s = "";
        if (type0) {
          if (!toUni) return null;
          for (let i = 0; i + 1 < bytes.length; i += 2) {
            const cp = toUni.get((bytes[i] << 8) | bytes[i + 1]);
            if (cp === undefined) return null;
            s += String.fromCodePoint(cp);
          }
          return s;
        }
        for (const b of bytes) {
          const cp = toUni?.get(b);
          if (cp !== undefined) s += String.fromCodePoint(cp);
          else if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
          else if (b >= 0xa0) s += String.fromCharCode(b);
          else if (CP1252[b]) s += CP1252[b];
          else return null;
        }
        return s;
      });
    } catch {
      // undecodable font: its ops simply never match
    }
  }
  return out;
}

// --- show-op collection -----------------------------------------------------

interface ShowOp {
  text: string | null;
  start: number; // first operand byte
  end: number; // end of operator token
  safe: boolean; // removal cannot shift the following text
  kind: string;
}

const POSITIONING = new Set(["Td", "TD", "Tm", "T*", "ET", "BT", "cm", "q", "Q"]);
const SHOWS = new Set(["Tj", "TJ", "'", '"']);

function collectShowOps(toks: Tok[], decoders: Map<string, Decoder>): ShowOp[] {
  const ops: ShowOp[] = [];
  const opSeq: { name: string; showIdx: number }[] = [];
  let operands: Tok[] = [];
  let font = "";
  for (const t of toks) {
    if (t.kind !== "op") {
      operands.push(t);
      continue;
    }
    const name = t.text!;
    if (name === "Tf" && operands.length >= 2) {
      const nameTok = operands[operands.length - 2];
      if (nameTok.kind === "name") font = nameTok.text!;
    } else if (SHOWS.has(name) && operands.length) {
      const chunks = operands.filter((o) => o.kind === "str").flatMap((o) => o.bytes ?? []);
      const dec = decoders.get(font);
      ops.push({
        text: dec ? dec(chunks) : null,
        start: operands[0].start,
        end: t.end,
        // ' and " do a T* line-advance themselves — removing them would
        // shift every following line, so they are never removed.
        safe: name === "Tj" || name === "TJ",
        kind: name,
      });
    }
    opSeq.push({ name, showIdx: SHOWS.has(name) ? ops.length - 1 : -1 });
    operands = [];
  }
  // A blanked op must not change where the NEXT show op draws: require an
  // absolute-positioning operator between them (or end of stream).
  let lastVerdict = true;
  for (let i = opSeq.length - 1; i >= 0; i--) {
    const { name, showIdx } = opSeq[i];
    if (showIdx >= 0) {
      ops[showIdx].safe = ops[showIdx].safe && lastVerdict;
      lastVerdict = false; // a show op directly after another is unsafe
    } else if (POSITIONING.has(name)) {
      lastVerdict = true;
    }
  }
  return ops;
}

// --- contents plumbing ------------------------------------------------------

function concatContents(page: PDFPage): Uint8Array | null {
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFRawStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (!(s instanceof PDFRawStream)) return null;
      streams.push(s);
    }
  } else return null;
  const parts = streams.map((s) => decodePDFRawStream(s).decode());
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  return out;
}

// --- entry point -------------------------------------------------------------

// wanted: origStr -> number of edits that replace exactly that string.
// Returns the set of strings whose operators were removed.
export function removeOriginalText(
  pdf: PDFDocument,
  page: PDFPage,
  wanted: Map<string, number>,
): Set<string> {
  const removed = new Set<string>();
  if (!wanted.size) return removed;
  try {
    const bytes = concatContents(page);
    if (!bytes) return removed;
    const ops = collectShowOps(tokenize(bytes), buildDecoders(page));
    const byText = new Map<string, number[]>();
    ops.forEach((op, i) => {
      if (op.text !== null && wanted.has(op.text)) {
        const arr = byText.get(op.text) ?? [];
        arr.push(i);
        byText.set(op.text, arr);
      }
    });
    const spans: [number, number][] = [];
    for (const [text, count] of wanted) {
      const idxs = byText.get(text) ?? [];
      if (idxs.length !== count) continue; // ambiguous — keep cover fallback
      if (!idxs.every((i) => ops[i].safe)) continue;
      for (const i of idxs) spans.push([ops[i].start, ops[i].end]);
      removed.add(text);
    }
    if (!spans.length) return removed;
    const out = bytes.slice();
    for (const [s, e] of spans) out.fill(0x20, s, e);
    const stream = pdf.context.flateStream(out);
    page.node.set(PDFName.of("Contents"), pdf.context.register(stream));
    return removed;
  } catch {
    return new Set(); // any surprise -> change nothing, covers still work
  }
}
