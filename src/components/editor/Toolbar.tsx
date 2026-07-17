import {
  MousePointer2,
  Type,
  Square,
  Circle,
  Minus,
  ArrowRight,
  Pencil,
  Highlighter,
  Image as ImageIcon,
  StickyNote,
  Signature,
  Undo2,
  Redo2,
  Download,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEditor, type Tool } from "@/lib/editor/store";
import { exportPdf, downloadBytes } from "@/lib/editor/exporter";
import { toast } from "sonner";
import { useRef, useState } from "react";
import { fileToDataUrl } from "@/lib/editor/loader";

const tools: { key: Tool; icon: typeof Type; label: string }[] = [
  { key: "select", icon: MousePointer2, label: "Select" },
  { key: "text", icon: Type, label: "Text" },
  { key: "highlight", icon: Highlighter, label: "Highlight" },
  { key: "draw", icon: Pencil, label: "Draw" },
  { key: "rect", icon: Square, label: "Rectangle" },
  { key: "ellipse", icon: Circle, label: "Ellipse" },
  { key: "line", icon: Minus, label: "Line" },
  { key: "arrow", icon: ArrowRight, label: "Arrow" },
  { key: "image", icon: ImageIcon, label: "Image" },
  { key: "note", icon: StickyNote, label: "Note" },
  { key: "signature", icon: Signature, label: "Signature" },
];

export function Toolbar({ onOpenSignature }: { onOpenSignature: () => void }) {
  const { tool, setTool, undo, redo, doc, zoom, setZoom, closeDocument, historyIndex, history } = useEditor();
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const addObject = useEditor((s) => s.addObject);
  const currentPage = useEditor((s) => s.currentPage);

  const handleTool = (t: Tool) => {
    if (t === "signature") {
      onOpenSignature();
      return;
    }
    if (t === "image") {
      fileInput.current?.click();
      return;
    }
    setTool(t);
  };

  const handleImage = async (f: File | null) => {
    if (!f || !doc) return;
    if (!/^image\//.test(f.type)) return toast.error("Not an image.");
    const src = await fileToDataUrl(f);
    const img = new Image();
    img.onload = () => {
      const page = doc.pages[currentPage];
      const pageAspect = page.width / page.height;
      const imgAspect = img.width / img.height;
      const w = 0.35;
      const h = (w / imgAspect) * pageAspect;
      addObject({
        type: "image",
        page: currentPage,
        x: 0.32,
        y: 0.4,
        w,
        h,
        rotation: 0,
        src,
        mime: f.type,
      });
      setTool("select");
    };
    img.src = src;
  };

  const handleExport = async () => {
    if (!doc) return;
    setExporting(true);
    try {
      const bytes = await exportPdf(doc);
      const name = doc.fileName.replace(/\.pdf$/i, "") + "-edited.pdf";
      downloadBytes(bytes, name);
      toast.success("Exported.");
    } catch (e) {
      console.error(e);
      toast.error("Export failed.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-14 items-center justify-between border-b bg-surface px-3">
      <div className="flex items-center gap-1">
        <button
          className="tool-btn"
          onClick={() => {
            if (confirm("Close this document? Your changes are saved locally.")) closeDocument();
          }}
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mx-2 h-6 w-px bg-border" />
        {tools.map((t) => (
          <button
            key={t.key}
            className="tool-btn"
            data-active={tool === t.key}
            onClick={() => handleTool(t.key)}
            title={t.label}
          >
            <t.icon className="h-4 w-4" />
          </button>
        ))}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            handleImage(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex items-center gap-2">
        <div className="mr-2 max-w-[24ch] truncate text-xs text-muted-foreground">
          {doc?.fileName}
        </div>
        <button
          className="tool-btn"
          onClick={undo}
          disabled={historyIndex <= 0}
          title="Undo"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          className="tool-btn"
          onClick={redo}
          disabled={historyIndex >= history.length - 1}
          title="Redo"
        >
          <Redo2 className="h-4 w-4" />
        </button>
        <div className="mx-1 h-6 w-px bg-border" />
        <button className="tool-btn" onClick={() => setZoom(zoom - 0.1)} title="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="w-10 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <button className="tool-btn" onClick={() => setZoom(zoom + 0.1)} title="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </button>
        <div className="mx-1 h-6 w-px bg-border" />
        <button
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {exporting ? "Exporting…" : "Export PDF"}
        </button>
      </div>
    </div>
  );
}
