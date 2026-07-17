export type ObjType =
  "text" | "rect" | "ellipse" | "line" | "arrow" | "draw" | "highlight" | "image" | "note";

export interface BaseObj {
  id: string;
  type: ObjType;
  page: number; // page index in `pages`
  x: number; // 0..1 relative to page width (top-left)
  y: number;
  w: number;
  h: number;
  rotation: number; // degrees
}

export interface TextObj extends BaseObj {
  type: "text";
  content: string;
  font: string;
  size: number; // pt
  color: string;
  bold?: boolean;
  italic?: boolean;
}

export interface ShapeObj extends BaseObj {
  type: "rect" | "ellipse" | "line" | "arrow";
  stroke: string;
  fill: string; // "none" or hex
  strokeWidth: number;
}

export interface DrawObj extends BaseObj {
  type: "draw";
  points: [number, number][]; // 0..1 coords relative to page
  color: string;
  size: number;
}

export interface HighlightObj extends BaseObj {
  type: "highlight";
  color: string; // hex with alpha optional
}

export interface ImageObj extends BaseObj {
  type: "image";
  src: string; // dataURL
  mime: string; // image/png | image/jpeg
}

export interface NoteObj extends BaseObj {
  type: "note";
  content: string;
  color: string;
}

export type EditorObj = TextObj | ShapeObj | DrawObj | HighlightObj | ImageObj | NoteObj;

export interface PageInfo {
  id: string;
  // If sourceIndex is null, this is a blank inserted page with fixed size.
  sourceIndex: number | null;
  rotation: 0 | 90 | 180 | 270;
  // Cached intrinsic size at rotation 0 (unrotated pdf page size).
  width: number;
  height: number;
}

export interface TextEdit {
  page: number;
  key: string; // stable text item key from extractor
  origStr: string;
  newStr: string;
  x: number; // normalized top-left
  y: number;
  w: number;
  h: number;
  fontSize: number; // PDF pt
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline?: boolean;
  strike?: boolean;
  color: string; // hex, e.g. "#0000ff"
  bgColor?: string; // hex, sampled page background behind the text
  baseline?: number; // normalized y of the text baseline, 0..1
  // Normalized drag offset from the original position (Canva-style move);
  // the cover always stays on the original footprint.
  dx?: number;
  dy?: number;
}

export interface DocumentState {
  fileName: string;
  fileDataUrl: string; // original PDF as dataURL (for persistence)
  pages: PageInfo[];
  objects: EditorObj[];
  textEdits?: TextEdit[];
}
