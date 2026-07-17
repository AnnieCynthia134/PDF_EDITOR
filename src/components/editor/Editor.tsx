import { useEffect, useState } from "react";
import { useEditor } from "@/lib/editor/store";
import { Toolbar } from "./Toolbar";
import { Thumbnails } from "./Thumbnails";
import { PageView } from "./PageView";
import { PropertiesPanel } from "./PropertiesPanel";
import { SignatureDialog } from "./SignatureDialog";

export function Editor() {
  const doc = useEditor((s) => s.doc)!;
  const selectedId = useEditor((s) => s.selectedId);
  const deleteObject = useEditor((s) => s.deleteObject);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const [sigOpen, setSigOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const editing = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (editing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteObject(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, deleteObject, undo, redo]);

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      // history saved locally, but warn if uncommitted intent
      if (useEditor.getState().dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background">
      <Toolbar onOpenSignature={() => setSigOpen(true)} />
      <div className="flex flex-1 overflow-hidden">
        <Thumbnails />
        <div className="flex-1 overflow-auto bg-canvas">
          {doc.pages.map((_, i) => (
            <div id={`page-anchor-${i}`} key={doc.pages[i].id}>
              <PageView index={i} />
            </div>
          ))}
        </div>
        <PropertiesPanel />
      </div>
      <SignatureDialog open={sigOpen} onClose={() => setSigOpen(false)} />
    </div>
  );
}
