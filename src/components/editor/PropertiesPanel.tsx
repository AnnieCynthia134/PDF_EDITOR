import { useEditor } from "@/lib/editor/store";
import type {
  EditorObj,
  TextObj,
  ShapeObj,
  HighlightObj,
  NoteObj,
  DrawObj,
} from "@/lib/editor/types";
import { Trash2 } from "lucide-react";

export function PropertiesPanel() {
  const selectedId = useEditor((s) => s.selectedId);
  const doc = useEditor((s) => s.doc);
  const update = useEditor((s) => s.updateObject);
  const del = useEditor((s) => s.deleteObject);
  const obj = doc?.objects.find((o) => o.id === selectedId) ?? null;

  return (
    <div className="flex h-full w-64 flex-col border-l bg-surface-elevated">
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Properties</div>
      <div className="flex-1 overflow-auto p-4 text-sm">
        {obj ? (
          <ObjectProps obj={obj} onChange={(p) => update(obj.id, p)} />
        ) : (
          <p className="text-xs text-muted-foreground">Select an object to edit its properties.</p>
        )}
      </div>
      {obj ? (
        <div className="border-t p-3">
          <button
            onClick={() => del(obj.id)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function ObjectProps({
  obj,
  onChange,
}: {
  obj: EditorObj;
  onChange: (p: Partial<EditorObj>) => void;
}) {
  if (obj.type === "text" || obj.type === "note") {
    const t = obj as TextObj | NoteObj;
    return (
      <>
        <Row label="Content">
          <textarea
            value={t.content}
            onChange={(e) => onChange({ content: e.target.value } as Partial<EditorObj>)}
            className="w-full rounded-md border bg-background p-2 text-xs"
            rows={4}
          />
        </Row>
        {obj.type === "text" ? (
          <>
            <Row label="Font">
              <select
                value={(obj as TextObj).font}
                onChange={(e) => onChange({ font: e.target.value } as Partial<EditorObj>)}
                className="w-full rounded-md border bg-background p-1.5 text-xs"
              >
                <option>Helvetica</option>
                <option>Arial</option>
                <option>Times</option>
                <option>Georgia</option>
                <option>Verdana</option>
                <option>Courier</option>
              </select>
            </Row>
            <Row label="Size">
              <input
                type="number"
                min={6}
                max={200}
                value={(obj as TextObj).size}
                onChange={(e) => onChange({ size: Number(e.target.value) } as Partial<EditorObj>)}
                className="w-full rounded-md border bg-background p-1.5 text-xs"
              />
            </Row>
            <Row label="Color">
              <input
                type="color"
                value={(obj as TextObj).color}
                onChange={(e) => onChange({ color: e.target.value } as Partial<EditorObj>)}
                className="h-8 w-full rounded-md border bg-background"
              />
            </Row>
            <Row label="Style">
              <div className="flex gap-2">
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={!!(obj as TextObj).bold}
                    onChange={(e) => onChange({ bold: e.target.checked } as Partial<EditorObj>)}
                  />{" "}
                  Bold
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={!!(obj as TextObj).italic}
                    onChange={(e) => onChange({ italic: e.target.checked } as Partial<EditorObj>)}
                  />{" "}
                  Italic
                </label>
              </div>
            </Row>
          </>
        ) : (
          <Row label="Color">
            <input
              type="color"
              value={(obj as NoteObj).color}
              onChange={(e) => onChange({ color: e.target.value } as Partial<EditorObj>)}
              className="h-8 w-full rounded-md border bg-background"
            />
          </Row>
        )}
      </>
    );
  }
  if (
    obj.type === "rect" ||
    obj.type === "ellipse" ||
    obj.type === "line" ||
    obj.type === "arrow"
  ) {
    const s = obj as ShapeObj;
    return (
      <>
        <Row label="Stroke color">
          <input
            type="color"
            value={s.stroke}
            onChange={(e) => onChange({ stroke: e.target.value } as Partial<EditorObj>)}
            className="h-8 w-full rounded-md border bg-background"
          />
        </Row>
        {obj.type === "rect" || obj.type === "ellipse" ? (
          <Row label="Fill">
            <div className="flex gap-2">
              <input
                type="color"
                value={s.fill === "none" ? "#ffffff" : s.fill}
                onChange={(e) => onChange({ fill: e.target.value } as Partial<EditorObj>)}
                className="h-8 flex-1 rounded-md border bg-background"
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={s.fill === "none"}
                  onChange={(e) =>
                    onChange({ fill: e.target.checked ? "none" : "#ffffff" } as Partial<EditorObj>)
                  }
                />{" "}
                None
              </label>
            </div>
          </Row>
        ) : null}
        <Row label="Stroke width">
          <input
            type="number"
            min={0.5}
            max={40}
            step={0.5}
            value={s.strokeWidth}
            onChange={(e) =>
              onChange({ strokeWidth: Number(e.target.value) } as Partial<EditorObj>)
            }
            className="w-full rounded-md border bg-background p-1.5 text-xs"
          />
        </Row>
      </>
    );
  }
  if (obj.type === "highlight") {
    return (
      <Row label="Color">
        <input
          type="color"
          value={(obj as HighlightObj).color}
          onChange={(e) => onChange({ color: e.target.value } as Partial<EditorObj>)}
          className="h-8 w-full rounded-md border bg-background"
        />
      </Row>
    );
  }
  if (obj.type === "draw") {
    const d = obj as DrawObj;
    return (
      <>
        <Row label="Color">
          <input
            type="color"
            value={d.color}
            onChange={(e) => onChange({ color: e.target.value } as Partial<EditorObj>)}
            className="h-8 w-full rounded-md border bg-background"
          />
        </Row>
        <Row label="Size">
          <input
            type="number"
            min={1}
            max={40}
            value={d.size}
            onChange={(e) => onChange({ size: Number(e.target.value) } as Partial<EditorObj>)}
            className="w-full rounded-md border bg-background p-1.5 text-xs"
          />
        </Row>
      </>
    );
  }
  return <p className="text-xs text-muted-foreground">No editable properties for this object.</p>;
}
