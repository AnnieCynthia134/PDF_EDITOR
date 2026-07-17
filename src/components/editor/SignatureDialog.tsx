import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/lib/editor/store";

export function SignatureDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasInk, setHasInk] = useState(false);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const doc = useEditor((s) => s.doc);
  const currentPage = useEditor((s) => s.currentPage);
  const addObject = useEditor((s) => s.addObject);

  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    if (!c) return;
    c.width = 600;
    c.height = 200;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    setHasInk(false);
  }, [open]);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvasRef.current!.width, y: ((e.clientY - r.top) / r.height) * canvasRef.current!.height };
  };

  if (!open) return null;

  const clear = () => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    setHasInk(false);
  };

  const insert = () => {
    if (!doc) return;
    const src = canvasRef.current!.toDataURL("image/png");
    const page = doc.pages[currentPage];
    const w = 0.3;
    const h = (w * (200 / 600)) * (page.width / page.height);
    addObject({
      type: "image",
      page: currentPage,
      x: 0.35,
      y: 0.6,
      w,
      h,
      rotation: 0,
      src,
      mime: "image/png",
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[640px] rounded-2xl bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-semibold">Draw signature</h3>
        <p className="mb-4 text-xs text-muted-foreground">Sign with your mouse or finger. It will be placed on the current page.</p>
        <canvas
          ref={canvasRef}
          className="w-full cursor-crosshair rounded-md border bg-white"
          style={{ height: 200 }}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            drawing.current = true;
            last.current = pos(e);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const p = pos(e);
            const ctx = canvasRef.current!.getContext("2d")!;
            ctx.strokeStyle = "#111";
            ctx.lineWidth = 2.5;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(last.current!.x, last.current!.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            last.current = p;
            setHasInk(true);
          }}
          onPointerUp={() => {
            drawing.current = false;
            last.current = null;
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={clear} className="rounded-md border px-3 py-1.5 text-xs">Clear</button>
          <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">Cancel</button>
          <button
            disabled={!hasInk}
            onClick={insert}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            Place signature
          </button>
        </div>
      </div>
    </div>
  );
}
