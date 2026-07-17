import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/lib/editor/store";
import { getPdfJs } from "@/lib/editor/pdfjs";
import { dataUrlToArrayBuffer } from "@/lib/editor/loader";
import { Plus, Trash2, RotateCw } from "lucide-react";

// Simple per-page thumbnail cache
const thumbCache = new Map<string, string>();

function useThumb(dataUrl: string, sourceIndex: number | null, rotation: number, revision: number) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (sourceIndex === null) {
      setUrl(null);
      return;
    }
    const key = `${dataUrl.slice(-32)}:${sourceIndex}:${rotation}`;
    if (thumbCache.has(key)) {
      setUrl(thumbCache.get(key)!);
      return;
    }
    let cancelled = false;
    (async () => {
      const ab = dataUrlToArrayBuffer(dataUrl);
      const pdfjs = await getPdfJs();
      const pdf = await pdfjs.getDocument({ data: ab }).promise;
      const p = await pdf.getPage(sourceIndex + 1);
      const vp = p.getViewport({ scale: 0.2, rotation });
      const c = document.createElement("canvas");
      c.width = vp.width;
      c.height = vp.height;
      await p.render({ canvasContext: c.getContext("2d")!, viewport: vp }).promise;
      const dataUrl2 = c.toDataURL("image/png");
      thumbCache.set(key, dataUrl2);
      if (!cancelled) setUrl(dataUrl2);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataUrl, sourceIndex, rotation, revision]);
  return url;
}

export function Thumbnails() {
  const doc = useEditor((s) => s.doc)!;
  const currentPage = useEditor((s) => s.currentPage);
  const setCurrentPage = useEditor((s) => s.setCurrentPage);
  const addBlankPage = useEditor((s) => s.addBlankPage);
  const deletePage = useEditor((s) => s.deletePage);
  const rotatePage = useEditor((s) => s.rotatePage);
  const reorderPage = useEditor((s) => s.reorderPage);
  const dragFrom = useRef<number | null>(null);

  return (
    <div className="flex h-full w-40 flex-col border-r bg-surface-elevated">
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Pages</div>
      <div className="flex-1 space-y-3 overflow-auto p-3">
        {doc.pages.map((p, i) => (
          <ThumbItem
            key={p.id}
            index={i}
            selected={i === currentPage}
            onSelect={() => {
              setCurrentPage(i);
              document.getElementById(`page-anchor-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            onDragStart={() => (dragFrom.current = i)}
            onDrop={() => {
              const from = dragFrom.current;
              if (from !== null && from !== i) reorderPage(from, i);
              dragFrom.current = null;
            }}
            onAddAfter={() => addBlankPage(i)}
            onDelete={() => {
              if (doc.pages.length > 1 && confirm("Delete this page?")) deletePage(i);
            }}
            onRotate={() => rotatePage(i, 90)}
          />
        ))}
      </div>
    </div>
  );
}

function ThumbItem({
  index,
  selected,
  onSelect,
  onDragStart,
  onDrop,
  onAddAfter,
  onDelete,
  onRotate,
}: {
  index: number;
  selected: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onAddAfter: () => void;
  onDelete: () => void;
  onRotate: () => void;
}) {
  const doc = useEditor((s) => s.doc)!;
  const info = doc.pages[index];
  const revision = doc.objects.filter((o) => o.page === index).length;
  const thumb = useThumb(doc.fileDataUrl, info.sourceIndex, info.rotation, revision);
  return (
    <div className="group">
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={onSelect}
        className={`relative cursor-pointer overflow-hidden rounded-md border bg-white transition ${
          selected ? "ring-2 ring-primary" : "hover:border-primary/40"
        }`}
        style={{ aspectRatio: `${info.width} / ${info.height}` }}
      >
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
            {info.sourceIndex === null ? "Blank" : "…"}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">{index + 1}</span>
        <div className="flex opacity-0 transition group-hover:opacity-100">
          <button onClick={onRotate} title="Rotate" className="p-1 text-muted-foreground hover:text-foreground">
            <RotateCw className="h-3 w-3" />
          </button>
          <button onClick={onAddAfter} title="Add blank after" className="p-1 text-muted-foreground hover:text-foreground">
            <Plus className="h-3 w-3" />
          </button>
          <button onClick={onDelete} title="Delete" className="p-1 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
