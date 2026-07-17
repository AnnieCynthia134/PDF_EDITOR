import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/lib/editor/store";
import type { EditorObj } from "@/lib/editor/types";
import { getStroke } from "perfect-freehand";

interface Props {
  obj: EditorObj;
  containerW: number;
  containerH: number;
  onSelect: (id: string) => void;
  onChange: (patch: Partial<EditorObj>) => void;
}

type DragState =
  | null
  | { kind: "move"; startX: number; startY: number; ox: number; oy: number }
  | { kind: "resize"; corner: "nw" | "ne" | "sw" | "se"; startX: number; startY: number; ox: number; oy: number; ow: number; oh: number };

export function EditableObject({ obj, containerW, containerH, onSelect, onChange }: Props) {
  const selectedId = useEditor((s) => s.selectedId);
  const tool = useEditor((s) => s.tool);
  const selected = selectedId === obj.id;
  const [drag, setDrag] = useState<DragState>(null);
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - drag.startX) / containerW;
      const dy = (e.clientY - drag.startY) / containerH;
      if (drag.kind === "move") {
        onChange({
          x: Math.max(0, Math.min(1 - obj.w, drag.ox + dx)),
          y: Math.max(0, Math.min(1 - obj.h, drag.oy + dy)),
        } as Partial<EditorObj>);
      } else {
        let x = drag.ox;
        let y = drag.oy;
        let w = drag.ow;
        let h = drag.oh;
        if (drag.corner.includes("e")) w = Math.max(0.01, drag.ow + dx);
        if (drag.corner.includes("s")) h = Math.max(0.01, drag.oh + dy);
        if (drag.corner.includes("w")) {
          x = drag.ox + dx;
          w = Math.max(0.01, drag.ow - dx);
        }
        if (drag.corner.includes("n")) {
          y = drag.oy + dy;
          h = Math.max(0.01, drag.oh - dy);
        }
        onChange({ x, y, w, h } as Partial<EditorObj>);
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, containerW, containerH, obj.w, obj.h, onChange]);

  const startMove = (e: React.PointerEvent) => {
    if (tool !== "select") return;
    e.stopPropagation();
    onSelect(obj.id);
    if (editing) return;
    setDrag({ kind: "move", startX: e.clientX, startY: e.clientY, ox: obj.x, oy: obj.y });
  };

  const startResize = (corner: "nw" | "ne" | "sw" | "se") => (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(obj.id);
    setDrag({ kind: "resize", corner, startX: e.clientX, startY: e.clientY, ox: obj.x, oy: obj.y, ow: obj.w, oh: obj.h });
  };

  const px = obj.x * containerW;
  const py = obj.y * containerH;
  const pw = obj.w * containerW;
  const ph = obj.h * containerH;

  const commitText = () => {
    if (!editRef.current) return;
    const content = editRef.current.innerText;
    onChange({ content } as Partial<EditorObj>);
    setEditing(false);
  };

  // Content per type
  let content: React.ReactNode = null;
  if (obj.type === "text") {
    content = (
      <div
        ref={editRef}
        contentEditable={editing}
        suppressContentEditableWarning
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            (e.target as HTMLElement).blur();
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
          setTimeout(() => editRef.current?.focus(), 0);
        }}
        style={{
          width: "100%",
          height: "100%",
          fontFamily: obj.font,
          fontSize: obj.size,
          color: obj.color,
          fontWeight: obj.bold ? 700 : 400,
          fontStyle: obj.italic ? "italic" : "normal",
          outline: "none",
          whiteSpace: "pre-wrap",
          overflow: "hidden",
          cursor: editing ? "text" : "move",
          lineHeight: 1.2,
        }}
      >
        {obj.content}
      </div>
    );
  } else if (obj.type === "rect") {
    content = (
      <div
        style={{
          width: "100%",
          height: "100%",
          border: `${obj.strokeWidth}px solid ${obj.stroke}`,
          background: obj.fill === "none" ? "transparent" : obj.fill,
        }}
      />
    );
  } else if (obj.type === "ellipse") {
    content = (
      <div
        style={{
          width: "100%",
          height: "100%",
          border: `${obj.strokeWidth}px solid ${obj.stroke}`,
          background: obj.fill === "none" ? "transparent" : obj.fill,
          borderRadius: "50%",
        }}
      />
    );
  } else if (obj.type === "line" || obj.type === "arrow") {
    // draw via inline SVG within bbox using w,h possibly negative
    const w = Math.abs(pw);
    const h = Math.abs(ph);
    const x1 = pw >= 0 ? 0 : w;
    const y1 = ph >= 0 ? 0 : h;
    const x2 = pw >= 0 ? w : 0;
    const y2 = ph >= 0 ? h : 0;
    content = (
      <svg width={w} height={h} style={{ overflow: "visible" }}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={obj.stroke} strokeWidth={obj.strokeWidth} />
        {obj.type === "arrow" ? (
          <polygon
            points={arrowHead(x1, y1, x2, y2, Math.max(6, obj.strokeWidth * 3))}
            fill={obj.stroke}
          />
        ) : null}
      </svg>
    );
  } else if (obj.type === "highlight") {
    content = <div style={{ width: "100%", height: "100%", background: obj.color, opacity: 0.35 }} />;
  } else if (obj.type === "image") {
    content = <img src={obj.src} alt="" className="h-full w-full object-fill" draggable={false} />;
  } else if (obj.type === "note") {
    content = (
      <div
        ref={editRef}
        contentEditable={editing}
        suppressContentEditableWarning
        onBlur={commitText}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
          setTimeout(() => editRef.current?.focus(), 0);
        }}
        style={{
          width: "100%",
          height: "100%",
          background: obj.color,
          border: "1px solid #d4c520",
          padding: 4,
          fontSize: 10,
          color: "#222",
          outline: "none",
          whiteSpace: "pre-wrap",
          overflow: "hidden",
          cursor: editing ? "text" : "move",
          boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
        }}
      >
        {obj.content}
      </div>
    );
  } else if (obj.type === "draw") {
    const pts = obj.points.map(([nx, ny]) => [nx * containerW, ny * containerH]);
    const stroke = getStroke(pts, { size: obj.size, thinning: 0.5, smoothing: 0.5, streamline: 0.5 });
    let d = "";
    if (stroke.length) {
      d = `M ${stroke[0][0]} ${stroke[0][1]}`;
      for (let i = 1; i < stroke.length; i++) d += ` L ${stroke[i][0]} ${stroke[i][1]}`;
      d += " Z";
    }
    // Draw objects use full-page bbox — render at absolute container size
    return (
      <svg
        className="pointer-events-none absolute left-0 top-0"
        width={containerW}
        height={containerH}
      >
        <path d={d} fill={obj.color} />
      </svg>
    );
  }

  const useNegBox = obj.type === "line" || obj.type === "arrow";
  const left = useNegBox ? Math.min(px, px + pw) : px;
  const top = useNegBox ? Math.min(py, py + ph) : py;
  const width = useNegBox ? Math.abs(pw) : pw;
  const height = useNegBox ? Math.abs(ph) : ph;

  return (
    <div
      className="pointer-events-auto absolute"
      style={{ left, top, width, height, transform: `rotate(${obj.rotation}deg)` }}
      onPointerDown={startMove}
    >
      {content}
      {selected ? (
        <>
          <div className="pointer-events-none absolute -inset-[2px] border border-primary" />
          {(["nw", "ne", "sw", "se"] as const).map((c) => (
            <div
              key={c}
              onPointerDown={startResize(c)}
              className="absolute h-2.5 w-2.5 rounded-sm border border-primary bg-white"
              style={{
                left: c.includes("w") ? -5 : "auto",
                right: c.includes("e") ? -5 : "auto",
                top: c.includes("n") ? -5 : "auto",
                bottom: c.includes("s") ? -5 : "auto",
                cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize",
              }}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const bx = x2 - ux * size;
  const by = y2 - uy * size;
  const p1x = bx + px * size * 0.5;
  const p1y = by + py * size * 0.5;
  const p2x = bx - px * size * 0.5;
  const p2y = by - py * size * 0.5;
  return `${x2},${y2} ${p1x},${p1y} ${p2x},${p2y}`;
}
