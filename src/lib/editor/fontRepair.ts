// CID-keyed subset fonts inside PDFs legally omit the sfnt tables fontkit
// needs (`cmap`, `name`, `post`) because the PDF itself maps chars -> glyphs.
// To re-embed such a font for edited text we synthesize those tables:
// `cmap` from the font's /ToUnicode CMap (+ /CIDToGIDMap), minimal `name`
// and `post`. Existing tables are never modified.

export interface EmbeddedFontEntry {
  bytes: Uint8Array;
  toUnicode?: string; // decoded /ToUnicode CMap text
  cidToGid?: Uint8Array; // /CIDToGIDMap stream (uint16 GIDs); undefined = identity
}

interface Sfnt {
  version: number;
  tables: Map<string, Uint8Array>;
}

function parseSfnt(bytes: Uint8Array): Sfnt | null {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(0);
  // 0x00010000 TrueType, 'OTTO' CFF-OpenType, 'true' Apple TrueType
  if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) return null;
  const num = dv.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < num; i++) {
    const o = 12 + i * 16;
    if (o + 16 > bytes.length) return null;
    const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const off = dv.getUint32(o + 8);
    const len = dv.getUint32(o + 12);
    if (off + len > bytes.length) return null;
    tables.set(tag, bytes.subarray(off, off + len));
  }
  return { version, tables };
}

function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const w =
      ((data[i] ?? 0) << 24) |
      ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) |
      (data[i + 3] ?? 0);
    sum = (sum + w) >>> 0;
  }
  return sum;
}

function buildSfnt(version: number, tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const num = tags.length;
  let size = 12 + num * 16;
  const offsets: number[] = [];
  for (const t of tags) {
    size = (size + 3) & ~3;
    offsets.push(size);
    size += tables.get(t)!.length;
  }
  const out = new Uint8Array((size + 3) & ~3);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, version);
  dv.setUint16(4, num);
  const pow2 = 1 << Math.floor(Math.log2(num));
  dv.setUint16(6, pow2 * 16);
  dv.setUint16(8, Math.floor(Math.log2(num)));
  dv.setUint16(10, num * 16 - pow2 * 16);
  tags.forEach((t, i) => {
    const data = tables.get(t)!;
    const o = 12 + i * 16;
    for (let j = 0; j < 4; j++) out[o + j] = t.charCodeAt(j);
    dv.setUint32(o + 4, tableChecksum(data));
    dv.setUint32(o + 8, offsets[i]);
    dv.setUint32(o + 12, data.length);
    out.set(data, offsets[i]);
  });
  return out;
}

// /ToUnicode CMap text -> Map<CID, unicode codepoint>
export function parseToUnicode(cmapText: string): Map<number, number> {
  const out = new Map<number, number>();
  const hex = (s: string) => parseInt(s, 16);
  const setDst = (cid: number, dst: string) => {
    if (dst.length <= 4) out.set(cid, hex(dst));
    else if (dst.length === 8) {
      const hi = hex(dst.slice(0, 4));
      const lo = hex(dst.slice(4));
      if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
        out.set(cid, (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000);
      }
    }
  };
  for (const m of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      setDst(hex(p[1]), p[2]);
    }
  }
  for (const m of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = hex(r[1]);
      const hi = hex(r[2]);
      const d = hex(r[3].slice(0, 4));
      for (let c = lo; c <= hi && c - lo < 0x10000; c++) out.set(c, d + (c - lo));
    }
    for (const r of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g)) {
      const lo = hex(r[1]);
      [...r[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((x, i) => setDst(lo + i, x[1]));
    }
  }
  return out;
}

// cmap format 4 (BMP), platform 3 encoding 1
function buildCmapTable(uniToGid: Map<number, number>): Uint8Array {
  const cps = [...uniToGid.keys()].filter((c) => c > 0 && c <= 0xfffe).sort((a, b) => a - b);
  const segs: { start: number; end: number; delta: number }[] = [];
  for (const cp of cps) {
    const delta = (uniToGid.get(cp)! - cp) & 0xffff;
    const last = segs[segs.length - 1];
    if (last && cp === last.end + 1 && delta === last.delta) last.end = cp;
    else segs.push({ start: cp, end: cp, delta });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 }); // required terminator
  const n = segs.length;
  const subLen = 16 + n * 8;
  const table = new Uint8Array(12 + subLen);
  const dv = new DataView(table.buffer);
  // cmap header: version 0, one encoding record (3,1) at offset 12
  dv.setUint16(0, 0);
  dv.setUint16(2, 1);
  dv.setUint16(4, 3);
  dv.setUint16(6, 1);
  dv.setUint32(8, 12);
  const s = 12; // subtable base
  dv.setUint16(s, 4);
  dv.setUint16(s + 2, subLen);
  dv.setUint16(s + 4, 0); // language
  dv.setUint16(s + 6, n * 2);
  const pow2 = 1 << Math.floor(Math.log2(n));
  dv.setUint16(s + 8, pow2 * 2);
  dv.setUint16(s + 10, Math.floor(Math.log2(n)));
  dv.setUint16(s + 12, n * 2 - pow2 * 2);
  segs.forEach((seg, i) => {
    dv.setUint16(s + 14 + i * 2, seg.end);
    dv.setUint16(s + 16 + n * 2 + i * 2, seg.start);
    dv.setUint16(s + 16 + n * 4 + i * 2, seg.delta);
    dv.setUint16(s + 16 + n * 6 + i * 2, 0); // idRangeOffset
  });
  return table;
}

function buildNameTable(psName: string): Uint8Array {
  const ascii = psName.replace(/[^\x20-\x7E]/g, "").slice(0, 63) || "Embedded";
  const entries: [number, string][] = [
    [1, ascii], // family
    [2, "Regular"], // subfamily
    [4, ascii], // full name
    [6, ascii.replace(/\s+/g, "")], // postscript name
  ];
  const strings = entries.map(([, v]) => {
    const b = new Uint8Array(v.length * 2); // UTF-16BE
    for (let i = 0; i < v.length; i++) {
      b[i * 2] = v.charCodeAt(i) >> 8;
      b[i * 2 + 1] = v.charCodeAt(i) & 0xff;
    }
    return b;
  });
  const stringOffset = 6 + entries.length * 12;
  const total = stringOffset + strings.reduce((a, b) => a + b.length, 0);
  const table = new Uint8Array(total);
  const dv = new DataView(table.buffer);
  dv.setUint16(0, 0); // format
  dv.setUint16(2, entries.length);
  dv.setUint16(4, stringOffset);
  let strOff = 0;
  entries.forEach(([id], i) => {
    const o = 6 + i * 12;
    dv.setUint16(o, 3); // platform: Windows
    dv.setUint16(o + 2, 1); // encoding: Unicode BMP
    dv.setUint16(o + 4, 0x409); // language: en-US
    dv.setUint16(o + 6, id);
    dv.setUint16(o + 8, strings[i].length);
    dv.setUint16(o + 10, strOff);
    table.set(strings[i], stringOffset + strOff);
    strOff += strings[i].length;
  });
  return table;
}

function buildPostTable(): Uint8Array {
  const table = new Uint8Array(32);
  new DataView(table.buffer).setUint32(0, 0x00030000); // v3: no glyph names
  return table;
}

// Returns a font program fontkit can parse, synthesizing missing tables when
// the PDF provides enough data; returns the input unchanged otherwise.
export function repairFontProgram(entry: EmbeddedFontEntry, realName: string): Uint8Array {
  const parsed = parseSfnt(entry.bytes);
  if (!parsed) return entry.bytes; // bare CFF etc. — nothing we can do here
  const { version, tables } = parsed;
  let changed = false;
  if (!tables.has("cmap")) {
    if (!entry.toUnicode) return entry.bytes;
    const cidToUni = parseToUnicode(entry.toUnicode);
    const uniToGid = new Map<number, number>();
    const g = entry.cidToGid;
    for (const [cid, uni] of cidToUni) {
      const gid = g ? ((g[cid * 2] ?? 0) << 8) | (g[cid * 2 + 1] ?? 0) : cid;
      if (gid && !uniToGid.has(uni)) uniToGid.set(uni, gid);
    }
    if (!uniToGid.size) return entry.bytes;
    tables.set("cmap", buildCmapTable(uniToGid));
    changed = true;
  }
  if (!tables.has("name")) {
    tables.set("name", buildNameTable(realName));
    changed = true;
  }
  if (!tables.has("post")) {
    tables.set("post", buildPostTable());
    changed = true;
  }
  return changed ? buildSfnt(version, tables) : entry.bytes;
}
