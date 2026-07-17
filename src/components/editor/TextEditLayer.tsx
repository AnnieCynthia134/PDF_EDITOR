import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/lib/editor/store";
import {
  extractPageText,
  measureTextWidth,
  domBaselineOffset,
  type PdfTextItem,
} from "@/lib/editor/textExtract";
import type { TextEdit } from "@/lib/editor/types";

interface PageLike {
  getTextContent: () => Promise<{ items: unknown[]; styles: Record<string, unknown> }>;
  getViewport: (o: { scale: number; rotation?: number }) => {
    width: number;
    height: number;
    transform: number[];
  };
}

interface Props {
  pageIndex: number;
  pdfPage: PageLike | null;
  containerW: number;
  containerH: number;
  enabled: boolean;
  canvas?: HTMLCanvasElement | null;
}

// Longer replacement text is squeezed horizontally to keep table cells and
// neighboring content intact; below this it overflows instead.
const MIN_SQUEEZE = 0.55;

// Replacement families offered in the edit toolbar (besides the original).
const FAMILIES = [
  { label: "Arial", css: "Arial, Helvetica, sans-serif" },
  { label: "Times New Roman", css: "Times New Roman, Times, serif" },
  { label: "Georgia", css: "Georgia, serif" },
  { label: "Courier", css: "Courier New, Courier, monospace" },
  { label: "Verdana", css: "Verdana, Geneva, sans-serif" },
];

interface Draft {
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  family: string | null; // null = keep the original font
}

// When the embedded pdf.js face is used it already carries the weight/slant.
// If the user overrides bold/italic away from the original we drop the
// embedded face (its style is baked in) and let the browser style the real
// family instead.
function familyFor(
  it: Pick<PdfTextItem, "fontFamily" | "embedded" | "bold" | "italic">,
  bold: boolean,
  italic: boolean,
): { family: string; synthBold: boolean; synthItalic: boolean } {
  const original = bold === it.bold && italic === it.italic;
  if (it.embedded && original) {
    return { family: it.fontFamily, synthBold: false, synthItalic: false };
  }
  const family = it.embedded ? it.fontFamily.replace(/^"[^"]*",\s*/, "") : it.fontFamily;
  return { family, synthBold: bold, synthItalic: italic };
}

const toolbarBtn = (active: boolean): React.CSSProperties => ({
  width: 22,
  height: 22,
  lineHeight: "20px",
  textAlign: "center",
  border: "1px solid #ddd",
  borderRadius: 4,
  background: active ? "#e0e7ff" : "#fff",
  color: "#111",
  fontSize: 12,
  cursor: "pointer",
  padding: 0,
});

interface DragInfo {
  key: string;
  startX: number;
  startY: number;
  baseDx: number;
  baseDy: number;
  moved: boolean;
  lastDx: number;
  lastDy: number;
  edit: TextEdit;
}

export function TextEditLayer({
  pageIndex,
  pdfPage,
  containerW,
  containerH,
  enabled,
  canvas,
}: Props) {
  const [items, setItems] = useState<PdfTextItem[]>([]);
  const doc = useEditor((s) => s.doc);
  const upsertTextEdit = useEditor((s) => s.upsertTextEdit);
  const removeTextEdit = useEditor((s) => s.removeTextEdit);
  const editRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const cancelRef = useRef(false); // Escape pressed: discard instead of commit
  const dragRef = useRef<DragInfo | null>(null);
  const [livePos, setLivePos] = useState<{ key: string; dx: number; dy: number } | null>(null);
  const zoom = useEditor((s) => s.zoom);

  useEffect(() => {
    let cancelled = false;
    if (!pdfPage) {
      setItems([]);
      return;
    }
    extractPageText(pdfPage as unknown as Parameters<typeof extractPageText>[0], canvas)
      .then((r) => {
        if (!cancelled) setItems(r);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfPage, canvas]);

  const pageEdits = (doc?.textEdits ?? []).filter((e) => e.page === pageIndex);
  const editsByKey = new Map<string, TextEdit>();
  pageEdits.forEach((e) => editsByKey.set(e.key, e));
  const itemKeys = new Set(items.map((i) => i.key));
  // Edits whose extraction key no longer matches (e.g. segmentation changed)
  // still render from their stored position and format.
  const orphans = pageEdits.filter((e) => !itemKeys.has(e.key));

  const activateEdit = (it: PdfTextItem, edit: TextEdit | undefined) => {
    setDraft({
      fontSize: edit?.fontSize ?? it.fontSize,
      color: edit?.color ?? it.color,
      bold: edit?.bold ?? it.bold,
      italic: edit?.italic ?? it.italic,
      underline: edit?.underline ?? false,
      strike: edit?.strike ?? false,
      family: edit && edit.fontFamily !== it.fontFamily ? edit.fontFamily : null,
    });
    setEditingKey(it.key);
    setTimeout(() => {
      const el = editRefs.current[it.key];
      el?.focus();
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }, 0);
  };

  const commitEdit = (it: PdfTextItem, edit: TextEdit | undefined) => {
    const el = editRefs.current[it.key];
    const d = draft;
    setEditingKey(null);
    setDraft(null);
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    if (!el || !d) return;
    const newStr = (el.textContent ?? "").replace(/\n+/g, " ");
    const moved = !!(edit && ((edit.dx ?? 0) !== 0 || (edit.dy ?? 0) !== 0));
    const dirty =
      newStr !== it.str ||
      d.fontSize !== it.fontSize ||
      d.color !== it.color ||
      d.bold !== it.bold ||
      d.italic !== it.italic ||
      d.underline ||
      d.strike ||
      d.family !== null;
    if (!dirty && !moved) {
      if (edit) removeTextEdit(pageIndex, it.key);
      return;
    }
    upsertTextEdit({
      page: pageIndex,
      key: it.key,
      origStr: it.str,
      newStr,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      fontSize: d.fontSize,
      fontFamily: d.family ?? it.fontFamily,
      bold: d.bold,
      italic: d.italic,
      underline: d.underline,
      strike: d.strike,
      color: d.color,
      bgColor: it.bgColor,
      baseline: it.baseline,
      dx: edit?.dx,
      dy: edit?.dy,
    });
  };

  // Canva-style drag-to-move for committed edits (threshold keeps dblclick).
  const startDrag = (edit: TextEdit) => (e: React.PointerEvent) => {
    if (!enabled || editingKey) return;
    e.preventDefault();
    dragRef.current = {
      key: edit.key,
      startX: e.clientX,
      startY: e.clientY,
      baseDx: edit.dx ?? 0,
      baseDy: edit.dy ?? 0,
      moved: false,
      lastDx: edit.dx ?? 0,
      lastDy: edit.dy ?? 0,
      edit,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const px = e.clientX - d.startX;
    const py = e.clientY - d.startY;
    if (!d.moved && Math.hypot(px, py) < 4) return;
    d.moved = true;
    d.lastDx = d.baseDx + px / containerW;
    d.lastDy = d.baseDy + py / containerH;
    setLivePos({ key: d.key, dx: d.lastDx, dy: d.lastDy });
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) upsertTextEdit({ ...d.edit, dx: d.lastDx, dy: d.lastDy });
    setLivePos(null);
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: enabled ? "auto" : "none" }}>
      {items.map((it) => {
        const edit = editsByKey.get(it.key);
        const isEditing = editingKey === it.key;

        // Effective formatting: live draft while editing, else stored edit,
        // else the original item.
        const eff: Draft =
          isEditing && draft
            ? draft
            : {
                fontSize: edit?.fontSize ?? it.fontSize,
                color: edit?.color ?? it.color,
                bold: edit?.bold ?? it.bold,
                italic: edit?.italic ?? it.italic,
                underline: edit?.underline ?? false,
                strike: edit?.strike ?? false,
                family: edit && edit.fontFamily !== it.fontFamily ? edit.fontFamily : null,
              };
        const { family, synthBold, synthItalic } = eff.family
          ? { family: eff.family, synthBold: eff.bold, synthItalic: eff.italic }
          : familyFor(it, eff.bold, eff.italic);
        const cssFont = eff.fontSize * zoom;
        const origW = Math.max(it.w * containerW, 12);
        const origH = Math.max(it.h * containerH, cssFont);
        const left = it.x * containerW;
        // Sit the overlay text on the exact PDF baseline when font metrics
        // are available; fall back to the extracted top edge otherwise.
        const baseOff = domBaselineOffset(family, cssFont, synthBold, synthItalic);
        const top = baseOff !== null ? it.baseline * containerH - baseOff : it.y * containerH;
        // Current translation: live drag preview wins over the stored offset
        const live = livePos && livePos.key === it.key ? livePos : null;
        const ndx = live ? live.dx : (edit?.dx ?? 0);
        const ndy = live ? live.dy : (edit?.dy ?? 0);
        const tdx = ndx * containerW;
        const tdy = ndy * containerH;

        const deco =
          [eff.underline ? "underline" : "", eff.strike ? "line-through" : ""].join(" ").trim() ||
          "none";

        const typo: React.CSSProperties = {
          fontFamily: family,
          fontSize: cssFont,
          fontWeight: synthBold ? 700 : 400,
          fontStyle: synthItalic ? "italic" : "normal",
          textDecoration: deco,
          lineHeight: 1,
          whiteSpace: "pre",
          padding: 0,
          margin: 0,
          boxSizing: "border-box",
        };

        // Cover for the original footprint: extends 0.25em below the
        // baseline so original descenders don't ghost through.
        const coverEl = (width: number) => (
          <div
            style={{
              position: "absolute",
              left,
              top,
              width,
              minHeight: origH,
              paddingBottom: cssFont * 0.25,
              background: it.bgColor,
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        );

        if (isEditing) {
          const toolbarTop = top + tdy > 36 ? top + tdy - 32 : top + tdy + origH + 6;
          return (
            <div
              key={it.key}
              onBlur={(e) => {
                // Commit only when focus leaves both the text and the toolbar
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                  commitEdit(it, edit);
                }
              }}
            >
              {tdx || tdy ? coverEl(origW) : null}
              <div
                style={{
                  position: "absolute",
                  left: left + tdx,
                  top: toolbarTop,
                  zIndex: 40,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  padding: "3px 5px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                }}
              >
                <select
                  title="Font family"
                  value={eff.family ?? ""}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setDraft((d) => (d ? { ...d, family: v } : d));
                  }}
                  style={{
                    height: 22,
                    maxWidth: 110,
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "#111",
                    background: "#fff",
                  }}
                >
                  <option value="">Original font</option>
                  {FAMILIES.map((f) => (
                    <option key={f.css} value={f.css}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  title="Bold"
                  style={{ ...toolbarBtn(eff.bold), fontWeight: 700 }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setDraft((d) => (d ? { ...d, bold: !d.bold } : d))}
                >
                  B
                </button>
                <button
                  type="button"
                  title="Italic"
                  style={{ ...toolbarBtn(eff.italic), fontStyle: "italic" }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setDraft((d) => (d ? { ...d, italic: !d.italic } : d))}
                >
                  I
                </button>
                <button
                  type="button"
                  title="Underline"
                  style={{ ...toolbarBtn(eff.underline), textDecoration: "underline" }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setDraft((d) => (d ? { ...d, underline: !d.underline } : d))}
                >
                  U
                </button>
                <button
                  type="button"
                  title="Strikethrough"
                  style={{ ...toolbarBtn(eff.strike), textDecoration: "line-through" }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setDraft((d) => (d ? { ...d, strike: !d.strike } : d))}
                >
                  S
                </button>
                <input
                  type="color"
                  title="Text color"
                  value={eff.color}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraft((d) => (d ? { ...d, color: v } : d));
                  }}
                  style={{
                    width: 24,
                    height: 22,
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    padding: 0,
                    cursor: "pointer",
                  }}
                />
                <input
                  type="number"
                  title="Font size (pt)"
                  min={4}
                  max={200}
                  value={Math.round(eff.fontSize)}
                  onChange={(e) => {
                    const v = Math.max(4, Math.min(200, Number(e.target.value) || 0));
                    setDraft((d) => (d ? { ...d, fontSize: v } : d));
                  }}
                  style={{
                    width: 52,
                    height: 22,
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    fontSize: 12,
                    padding: "0 4px",
                    color: "#111",
                    background: "#fff",
                  }}
                />
                <button
                  type="button"
                  title="Restore original"
                  style={toolbarBtn(false)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    cancelRef.current = true;
                    setEditingKey(null);
                    setDraft(null);
                    removeTextEdit(pageIndex, it.key);
                  }}
                >
                  ↺
                </button>
                <button
                  type="button"
                  title="Done (Enter)"
                  style={{ ...toolbarBtn(false), color: "#15803d", fontWeight: 700 }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitEdit(it, edit)}
                >
                  ✓
                </button>
              </div>
              <div
                ref={(el) => {
                  editRefs.current[it.key] = el;
                }}
                contentEditable
                suppressContentEditableWarning
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRef.current = true; // discard changes
                    (e.currentTarget as HTMLElement).blur();
                  }
                }}
                style={{
                  ...typo,
                  position: "absolute",
                  left: left + tdx,
                  top: top + tdy,
                  minWidth: origW,
                  width: "max-content",
                  minHeight: origH,
                  paddingBottom: cssFont * 0.25, // cover original descenders
                  color: eff.color,
                  WebkitTextFillColor: eff.color,
                  caretColor: eff.color,
                  background: it.bgColor,
                  outline: "1.5px solid hsl(var(--primary))",
                  overflow: "visible",
                  userSelect: "text",
                  cursor: "text",
                  zIndex: 20,
                }}
              >
                {edit ? edit.newStr : it.str}
              </div>
            </div>
          );
        }

        if (edit) {
          // Text within 12% of the original width snaps to it exactly (Tz),
          // keeping alignment pixel-perfect; longer text squeezes so it stays
          // inside the original footprint (table cells, columns).
          const newW =
            measureTextWidth(edit.newStr, family, cssFont, synthBold, synthItalic) || origW;
          const ratio =
            Math.abs(newW - origW) / origW <= 0.12
              ? origW / newW
              : newW > origW
                ? Math.max(origW / newW, MIN_SQUEEZE)
                : 1;
          const coverW = Math.max(origW, newW * ratio);
          return (
            <div key={it.key}>
              {coverEl(coverW)}
              <div
                title="Drag to move · double-click to edit"
                onPointerDown={startDrag(edit)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onDoubleClick={(e) => {
                  if (!enabled) return;
                  e.stopPropagation();
                  activateEdit(it, edit);
                }}
                style={{
                  position: "absolute",
                  left: left + tdx,
                  top: top + tdy,
                  width: coverW,
                  minHeight: origH,
                  overflow: "visible",
                  cursor: enabled ? "move" : "default",
                  userSelect: "none",
                  touchAction: "none",
                  zIndex: 2,
                }}
              >
                <span
                  style={{
                    ...typo,
                    // block, not inline-block: an inline-block baseline-aligns
                    // against the div's inherited strut (16px/1.5 preflight) and
                    // the text visibly drops below the original position.
                    display: "block",
                    color: eff.color,
                    WebkitTextFillColor: eff.color,
                    transform: ratio !== 1 ? `scaleX(${ratio})` : undefined,
                    transformOrigin: "left top",
                  }}
                >
                  {edit.newStr}
                </span>
              </div>
            </div>
          );
        }

        // Pristine: invisible overlay, PDF canvas shows through
        return (
          <div
            key={it.key}
            onDoubleClick={(e) => {
              if (!enabled) return;
              e.stopPropagation();
              activateEdit(it, undefined);
            }}
            style={{
              ...typo,
              position: "absolute",
              left,
              top,
              width: origW,
              minHeight: origH,
              color: "transparent",
              WebkitTextFillColor: "transparent",
              background: "transparent",
              overflow: "hidden",
              cursor: enabled ? "text" : "default",
              userSelect: "none",
            }}
          >
            {it.str}
          </div>
        );
      })}
      {orphans.map((e) => {
        const cssFont = e.fontSize * zoom;
        const baseOff =
          e.baseline !== undefined
            ? domBaselineOffset(e.fontFamily, cssFont, e.bold, e.italic)
            : null;
        const top =
          baseOff !== null && e.baseline !== undefined
            ? e.baseline * containerH - baseOff
            : e.y * containerH;
        const deco =
          [e.underline ? "underline" : "", e.strike ? "line-through" : ""].join(" ").trim() ||
          "none";
        return (
          <div
            key={`orphan-${e.key}`}
            title="Double-click to restore original text"
            onDoubleClick={(ev) => {
              if (!enabled) return;
              ev.stopPropagation();
              removeTextEdit(pageIndex, e.key);
            }}
            style={{
              position: "absolute",
              left: (e.x + (e.dx ?? 0)) * containerW,
              top: top + (e.dy ?? 0) * containerH,
              minWidth: Math.max(e.w * containerW, 12),
              minHeight: Math.max(e.h * containerH, cssFont),
              fontFamily: e.fontFamily,
              fontSize: cssFont,
              fontWeight: e.bold ? 700 : 400,
              fontStyle: e.italic ? "italic" : "normal",
              textDecoration: deco,
              lineHeight: 1,
              whiteSpace: "pre",
              color: e.color,
              WebkitTextFillColor: e.color,
              background: e.bgColor ?? "#ffffff",
              cursor: enabled ? "pointer" : "default",
              userSelect: "none",
              zIndex: 1,
            }}
          >
            {e.newStr}
          </div>
        );
      })}
    </div>
  );
}
