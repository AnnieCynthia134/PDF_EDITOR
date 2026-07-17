import { useEffect, useRef, useState } from "react";
import { getPdfJs } from "@/lib/editor/pdfjs";
import { useEditor } from "@/lib/editor/store";
import { dataUrlToArrayBuffer } from "@/lib/editor/loader";
import { EditableObject } from "./EditableObject";
import { TextEditLayer } from "./TextEditLayer";
import { getStroke } from "perfect-freehand";
import { nanoid } from "nanoid";
import type { EditorObj } from "@/lib/editor/types";

// Shared PDFDocumentProxy per file dataUrl
const pdfCache = new Map<string, Promise<{ getPage: (n: number) => Promise<unknown> }>>();
function getPdf(dataUrl: string): Promise<{ getPage: (n: number) => Promise<unknown> }> {
  let p = pdfCache.get(dataUrl);
  if (!p) {
    p = (async () => {
      const ab = dataUrlToArrayBuffer(dataUrl);
      const pdfjs = await getPdfJs();
      // fontExtraProperties: keep translated font programs for the exporter
      return (await pdfjs.getDocument({ data: ab, fontExtraProperties: true })
        .promise) as unknown as {
        getPage: (n: number) => Promise<unknown>;
      };
    })();
    pdfCache.set(dataUrl, p);
  }
  return p;
}

const RENDER_SCALE = 1.5; // internal canvas resolution for crisp rendering

export function PageView({ index }: { index: number }) {
  const doc = useEditor((s) => s.doc)!;
  const page = doc.pages[index];
  const zoom = useEditor((s) => s.zoom);
  const tool = useEditor((s) => s.tool);
  const setCurrentPage = useEditor((s) => s.setCurrentPage);
  const addObject = useEditor((s) => s.addObject);
  const updateObject = useEditor((s) => s.updateObject);
  const select = useEditor((s) => s.select);
  const objects = doc.objects.filter((o) => o.page === index);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [pdfPage, setPdfPage] = useState<unknown | null>(null);
  type DrawingState =
    | null
    | { type: "draw"; points: [number, number][] }
    | { type: "shape"; startX: number; startY: number; curX: number; curY: number };
  const [drawing, setDrawingState] = useState<DrawingState>(null);
  const drawingRef = useRef<DrawingState>(null);
  const setDrawing = (d: DrawingState) => {
    drawingRef.current = d;
    setDrawingState(d);
  };

  // Render pdf.js page
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rot = page.rotation;
      const dispW = rot % 180 === 0 ? page.width : page.height;
      const dispH = rot % 180 === 0 ? page.height : page.width;
      const cssW = dispW * zoom;
      const cssH = dispH * zoom;
      setDisplaySize({ w: cssW, h: cssH });
      canvas.width = Math.round(cssW * RENDER_SCALE);
      canvas.height = Math.round(cssH * RENDER_SCALE);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";

      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (page.sourceIndex === null) {
        // blank page rendered as white
        setPdfPage(null);
        return;
      }
      const pdf = await getPdf(doc.fileDataUrl);
      if (cancelled) return;
      const p = (await pdf.getPage(page.sourceIndex + 1)) as {
        getViewport: (o: { scale: number; rotation: number }) => { width: number; height: number };
        render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => {
          promise: Promise<void>;
        };
      };
      const viewport = p.getViewport({ scale: zoom * RENDER_SCALE, rotation: rot });
      await p.render({ canvasContext: ctx, viewport }).promise;
      if (!cancelled) setPdfPage(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.fileDataUrl, page.sourceIndex, page.rotation, page.width, page.height, zoom]);

  const norm = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    return { nx: Math.max(0, Math.min(1, nx)), ny: Math.max(0, Math.min(1, ny)) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    setCurrentPage(index);
    if (tool === "select") {
      select(null);
      return;
    }
    const { nx, ny } = norm(e);
    if (tool === "text") {
      addObject({
        type: "text",
        page: index,
        x: nx,
        y: ny,
        w: 0.25,
        h: 0.04,
        rotation: 0,
        content: "Type here",
        font: "Helvetica",
        size: 16,
        color: "#111111",
      });
      useEditor.getState().setTool("select");
      return;
    }
    if (tool === "note") {
      addObject({
        type: "note",
        page: index,
        x: nx,
        y: ny,
        w: 0.18,
        h: 0.1,
        rotation: 0,
        content: "Note",
        color: "#fff59d",
      });
      useEditor.getState().setTool("select");
      return;
    }
    if (tool === "draw") {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDrawing({ type: "draw", points: [[nx, ny]] });
      return;
    }
    if (
      tool === "rect" ||
      tool === "ellipse" ||
      tool === "line" ||
      tool === "arrow" ||
      tool === "highlight"
    ) {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDrawing({ type: "shape", startX: nx, startY: ny, curX: nx, curY: ny });
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d) return;
    const { nx, ny } = norm(e);
    if (d.type === "draw") {
      setDrawing({ type: "draw", points: [...d.points, [nx, ny]] });
    } else {
      setDrawing({ ...d, curX: nx, curY: ny });
    }
  };

  const onPointerUp = () => {
    const d = drawingRef.current;
    if (!d) return;
    setDrawing(null);
    if (d.type === "draw") {
      if (d.points.length < 2) return;
      addObject({
        type: "draw",
        page: index,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        rotation: 0,
        points: d.points,
        color: "#111111",
        size: 3,
      });
      return;
    }
    const x = Math.min(d.startX, d.curX);
    const y = Math.min(d.startY, d.curY);
    const w = Math.abs(d.curX - d.startX);
    const h = Math.abs(d.curY - d.startY);
    if (w < 0.005 && h < 0.005) return;
    if (tool === "rect" || tool === "ellipse") {
      addObject({
        type: tool,
        page: index,
        x,
        y,
        w: Math.max(w, 0.02),
        h: Math.max(h, 0.02),
        rotation: 0,
        stroke: "#111111",
        fill: "none",
        strokeWidth: 2,
      });
    } else if (tool === "line" || tool === "arrow") {
      addObject({
        type: tool,
        page: index,
        x: d.startX,
        y: d.startY,
        w: d.curX - d.startX,
        h: d.curY - d.startY,
        rotation: 0,
        stroke: "#111111",
        fill: "none",
        strokeWidth: 2,
      });
    } else if (tool === "highlight") {
      addObject({
        type: "highlight",
        page: index,
        x,
        y,
        w: Math.max(w, 0.02),
        h: Math.max(h, 0.02),
        rotation: 0,
        color: "#ffeb3b",
      });
    }
    useEditor.getState().setTool("select");
  };

  // Live preview of in-progress freehand
  const previewPath = (() => {
    const d = drawingRef.current;
    if (!d || d.type !== "draw") return null;
    const pts = d.points.map(([nx, ny]) => [nx * displaySize.w, ny * displaySize.h]);
    const stroke = getStroke(pts, {
      size: 3 * zoom,
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
    });
    if (!stroke.length) return null;
    let path = `M ${stroke[0][0]} ${stroke[0][1]}`;
    for (let i = 1; i < stroke.length; i++) path += ` L ${stroke[i][0]} ${stroke[i][1]}`;
    return path + " Z";
  })();

  const previewShape = (() => {
    const d = drawingRef.current;
    if (!d || d.type !== "shape") return null;
    const x = Math.min(d.startX, d.curX) * displaySize.w;
    const y = Math.min(d.startY, d.curY) * displaySize.h;
    const w = Math.abs(d.curX - d.startX) * displaySize.w;
    const h = Math.abs(d.curY - d.startY) * displaySize.h;
    return {
      x,
      y,
      w,
      h,
      sx: d.startX * displaySize.w,
      sy: d.startY * displaySize.h,
      cx: d.curX * displaySize.w,
      cy: d.curY * displaySize.h,
    };
  })();

  const cursor =
    tool === "select"
      ? "default"
      : tool === "text"
        ? "text"
        : tool === "draw"
          ? "crosshair"
          : "crosshair";

  return (
    <div className="relative mx-auto my-6" style={{ width: displaySize.w }}>
      <div className="mb-1 text-center text-[10px] uppercase tracking-wider text-muted-foreground">
        Page {index + 1}
      </div>
      <div
        ref={wrapRef}
        className="relative editor-canvas-shadow"
        style={{ width: displaySize.w, height: displaySize.h, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="pointer-events-none block" />
        {/* Original PDF text — double-click to edit inline */}
        {page.rotation === 0 && pdfPage ? (
          <TextEditLayer
            pageIndex={index}
            pdfPage={pdfPage as Parameters<typeof TextEditLayer>[0]["pdfPage"]}
            containerW={displaySize.w}
            containerH={displaySize.h}
            enabled={tool === "select"}
            canvas={canvasRef.current}
          />
        ) : null}
        {/* Objects overlay */}
        <div className="pointer-events-none absolute inset-0">
          {objects.map((o) => (
            <EditableObject
              key={o.id}
              obj={o}
              containerW={displaySize.w}
              containerH={displaySize.h}
              onSelect={(id) => {
                setCurrentPage(index);
                select(id);
              }}
              onChange={(patch) => updateObject(o.id, patch)}
            />
          ))}
        </div>
        {/* Live preview */}
        {previewPath ? (
          <svg
            className="pointer-events-none absolute inset-0"
            width={displaySize.w}
            height={displaySize.h}
          >
            <path d={previewPath} fill="#111" />
          </svg>
        ) : null}
        {previewShape ? (
          <svg
            className="pointer-events-none absolute inset-0"
            width={displaySize.w}
            height={displaySize.h}
          >
            {tool === "rect" ? (
              <rect
                x={previewShape.x}
                y={previewShape.y}
                width={previewShape.w}
                height={previewShape.h}
                fill="none"
                stroke="#111"
                strokeWidth={2}
              />
            ) : tool === "ellipse" ? (
              <ellipse
                cx={previewShape.x + previewShape.w / 2}
                cy={previewShape.y + previewShape.h / 2}
                rx={previewShape.w / 2}
                ry={previewShape.h / 2}
                fill="none"
                stroke="#111"
                strokeWidth={2}
              />
            ) : tool === "line" || tool === "arrow" ? (
              <line
                x1={previewShape.sx}
                y1={previewShape.sy}
                x2={previewShape.cx}
                y2={previewShape.cy}
                stroke="#111"
                strokeWidth={2}
              />
            ) : tool === "highlight" ? (
              <rect
                x={previewShape.x}
                y={previewShape.y}
                width={previewShape.w}
                height={previewShape.h}
                fill="#ffeb3b"
                opacity={0.35}
              />
            ) : null}
          </svg>
        ) : null}
      </div>
    </div>
  );
}

// Silence unused imports (kept for type reference)
export type _Unused = EditorObj | typeof nanoid;
