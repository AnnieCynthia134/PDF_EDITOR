// Registry of font programs translated by pdf.js while rendering pages.
// pdf.js converts every embedded font type (TrueType, Type1, CFF/OpenType)
// into a browser-valid program — the exact face the on-screen overlay text
// uses. Exporting with these bytes makes the saved PDF match the screen even
// for font types the source-PDF extraction path can't handle.
const programs = new Map<string, Uint8Array>();

export function registerFontProgram(name: string, data: Uint8Array | null | undefined) {
  if (name && data && !programs.has(name)) programs.set(name, data);
}

export function getFontProgram(name: string): Uint8Array | undefined {
  return programs.get(name);
}
