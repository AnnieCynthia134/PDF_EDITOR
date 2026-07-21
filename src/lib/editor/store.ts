import { create } from "zustand";
import { nanoid } from "nanoid";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import type { DocumentState, EditorObj, PageInfo } from "./types";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Tool =
  | "select"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "draw"
  | "highlight"
  | "image"
  | "note"
  | "signature";

interface Snapshot {
  pages: PageInfo[];
  objects: EditorObj[];
  textEdits: import("./types").TextEdit[];
}

interface EditorState {
  doc: DocumentState | null;
  tool: Tool;
  selectedId: string | null;
  zoom: number;
  currentPage: number;
  history: Snapshot[];
  historyIndex: number;
  dirty: boolean;

  setTool: (t: Tool) => void;
  setZoom: (z: number) => void;
  setCurrentPage: (p: number) => void;
  select: (id: string | null) => void;

  loadDocument: (doc: DocumentState) => void;
  closeDocument: () => void;

  addObject: (obj: DistributiveOmit<EditorObj, "id">) => string;
  updateObject: (id: string, patch: Partial<EditorObj>) => void;
  deleteObject: (id: string) => void;

  upsertTextEdit: (edit: import("./types").TextEdit) => void;
  removeTextEdit: (page: number, key: string) => void;

  addBlankPage: (after: number) => void;
  deletePage: (index: number) => void;
  rotatePage: (index: number, delta: 90 | -90) => void;
  reorderPage: (from: number, to: number) => void;

  undo: () => void;
  redo: () => void;

  restore: () => Promise<boolean>;
  clearPersisted: () => Promise<void>;
}

const STORAGE_KEY = "pdf-editor-doc-v1";

function snapshot(doc: DocumentState): Snapshot {
  return {
    pages: doc.pages.map((p) => ({ ...p })),
    objects: doc.objects.map((o) => ({ ...o })),
    textEdits: (doc.textEdits ?? []).map((e) => ({ ...e })),
  };
}

function persist(doc: DocumentState | null) {
  if (!doc) {
    void idbDel(STORAGE_KEY);
    return;
  }
  void idbSet(STORAGE_KEY, doc);
}

let persistTimer: number | null = null;
function schedulePersist(doc: DocumentState | null) {
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => persist(doc), 800);
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  tool: "select",
  selectedId: null,
  zoom: 1,
  currentPage: 0,
  history: [],
  historyIndex: -1,
  dirty: false,

  setTool: (t) => set({ tool: t, selectedId: t === "select" ? get().selectedId : null }),
  setZoom: (z) => set({ zoom: Math.max(0.25, Math.min(4, z)) }),
  setCurrentPage: (p) => set({ currentPage: p }),
  select: (id) => set({ selectedId: id }),

  loadDocument: (doc) => {
    const snap = snapshot(doc);
    set({
      doc,
      history: [snap],
      historyIndex: 0,
      selectedId: null,
      currentPage: 0,
      zoom: 1,
      tool: "select",
      dirty: false,
    });
    persist(doc);
  },

  closeDocument: () => {
    set({
      doc: null,
      history: [],
      historyIndex: -1,
      selectedId: null,
      currentPage: 0,
    });
    persist(null);
  },

  addObject: (obj) => {
    const id = nanoid(8);
    const state = get();
    if (!state.doc) return id;
    const newObj = { ...obj, id } as EditorObj;
    const newDoc: DocumentState = {
      ...state.doc,
      objects: [...state.doc.objects, newObj],
    };
    pushHistory(set, get, newDoc, { selectedId: id });
    return id;
  },

  updateObject: (id, patch) => {
    const state = get();
    if (!state.doc) return;
    const newDoc: DocumentState = {
      ...state.doc,
      objects: state.doc.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as EditorObj) : o)),
    };
    pushHistory(set, get, newDoc);
  },

  deleteObject: (id) => {
    const state = get();
    if (!state.doc) return;
    const newDoc: DocumentState = {
      ...state.doc,
      objects: state.doc.objects.filter((o) => o.id !== id),
    };
    pushHistory(set, get, newDoc, { selectedId: null });
  },

  upsertTextEdit: (edit) => {
    const state = get();
    if (!state.doc) return;
    const existing = state.doc.textEdits ?? [];
    const filtered = existing.filter((e) => !(e.page === edit.page && e.key === edit.key));
    const newDoc: DocumentState = { ...state.doc, textEdits: [...filtered, edit] };
    pushHistory(set, get, newDoc);
  },

  removeTextEdit: (page, key) => {
    const state = get();
    if (!state.doc) return;
    const existing = state.doc.textEdits ?? [];
    const filtered = existing.filter((e) => !(e.page === page && e.key === key));
    const newDoc: DocumentState = { ...state.doc, textEdits: filtered };
    pushHistory(set, get, newDoc);
  },

  addBlankPage: (after) => {
    const state = get();
    if (!state.doc) return;
    const newPage: PageInfo = {
      id: nanoid(6),
      sourceIndex: null,
      rotation: 0,
      width: 612,
      height: 792,
    };
    const pages = [...state.doc.pages];
    pages.splice(after + 1, 0, newPage);
    const newDoc = remapPages(state.doc, pages);
    pushHistory(set, get, newDoc, { currentPage: after + 1 });
  },

  deletePage: (index) => {
    const state = get();
    if (!state.doc || state.doc.pages.length <= 1) return;
    const pages = state.doc.pages.filter((_, i) => i !== index);
    const objects = state.doc.objects
      .filter((o) => o.page !== index)
      .map((o) => (o.page > index ? { ...o, page: o.page - 1 } : o));
    const newDoc: DocumentState = { ...state.doc, pages, objects };
    pushHistory(set, get, newDoc, {
      currentPage: Math.max(0, Math.min(state.currentPage, pages.length - 1)),
    });
  },

  rotatePage: (index, delta) => {
    const state = get();
    if (!state.doc) return;
    const pages = state.doc.pages.map((p, i) => {
      if (i !== index) return p;
      const next = ((p.rotation + delta + 360) % 360) as 0 | 90 | 180 | 270;
      return { ...p, rotation: next };
    });
    const newDoc: DocumentState = { ...state.doc, pages };
    pushHistory(set, get, newDoc);
  },

  reorderPage: (from, to) => {
    const state = get();
    if (!state.doc || from === to) return;
    const pages = [...state.doc.pages];
    const [moved] = pages.splice(from, 1);
    pages.splice(to, 0, moved);
    const newDoc = remapPages(state.doc, pages, from, to);
    pushHistory(set, get, newDoc, { currentPage: to });
  },

  undo: () => {
    const state = get();
    if (state.historyIndex <= 0 || !state.doc) return;
    const idx = state.historyIndex - 1;
    const snap = state.history[idx];
    set({
      historyIndex: idx,
      doc: { ...state.doc, pages: snap.pages, objects: snap.objects, textEdits: snap.textEdits },
      selectedId: null,
      dirty: true,
    });
    schedulePersist(get().doc);
  },

  redo: () => {
    const state = get();
    if (state.historyIndex >= state.history.length - 1 || !state.doc) return;
    const idx = state.historyIndex + 1;
    const snap = state.history[idx];
    set({
      historyIndex: idx,
      doc: { ...state.doc, pages: snap.pages, objects: snap.objects, textEdits: snap.textEdits },
      selectedId: null,
      dirty: true,
    });
    schedulePersist(get().doc);
  },

  restore: async () => {
    const stored = (await idbGet(STORAGE_KEY)) as DocumentState | undefined;
    if (!stored) return false;
    const snap = snapshot(stored);
    set({
      doc: stored,
      history: [snap],
      historyIndex: 0,
      selectedId: null,
      currentPage: 0,
      zoom: 1,
      tool: "select",
      dirty: false,
    });
    return true;
  },

  clearPersisted: async () => {
    await idbDel(STORAGE_KEY);
  },
}));

function pushHistory(
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState,
  newDoc: DocumentState,
  extra: Partial<EditorState> = {},
) {
  const state = get();
  const trimmed = state.history.slice(0, state.historyIndex + 1);
  trimmed.push(snapshot(newDoc));
  // cap history length
  const capped = trimmed.length > 80 ? trimmed.slice(trimmed.length - 80) : trimmed;
  set({
    doc: newDoc,
    history: capped,
    historyIndex: capped.length - 1,
    dirty: true,
    ...extra,
  });
  schedulePersist(newDoc);
}

// When pages array changes structurally (add blank / reorder), objects still
// point to page indices, so we remap. For blank inserts, we shift indices for
// objects on pages >= insertion point. For reorder, we remap by page id.
function remapPages(
  doc: DocumentState,
  newPages: PageInfo[],
  reorderFrom?: number,
  reorderTo?: number,
): DocumentState {
  if (reorderFrom !== undefined && reorderTo !== undefined) {
    // Build oldIndex -> newIndex map by page id
    const oldIds = doc.pages.map((p) => p.id);
    const newIdx = new Map<string, number>();
    newPages.forEach((p, i) => newIdx.set(p.id, i));
    const objects = doc.objects.map((o) => {
      const oldId = oldIds[o.page];
      const mapped = newIdx.get(oldId);
      return mapped === undefined ? o : { ...o, page: mapped };
    });
    return { ...doc, pages: newPages, objects };
  }
  // Insert blank: figure out which index shifted
  // Diff: find the id in newPages that isn't in old
  const oldIds = new Set(doc.pages.map((p) => p.id));
  const insertedAt = newPages.findIndex((p) => !oldIds.has(p.id));
  if (insertedAt === -1) return { ...doc, pages: newPages };
  const objects = doc.objects.map((o) => (o.page >= insertedAt ? { ...o, page: o.page + 1 } : o));
  return { ...doc, pages: newPages, objects };
}
