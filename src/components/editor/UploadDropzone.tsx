import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileText } from "lucide-react";
import { useEditor } from "@/lib/editor/store";
import { buildDocumentFromFile } from "@/lib/editor/loader";
import { toast } from "sonner";

export function UploadDropzone({ onRestore }: { onRestore?: () => void }) {
  const loadDocument = useEditor((s) => s.loadDocument);
  const [loading, setLoading] = useState(false);

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
        toast.error("Please upload a PDF file.");
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        toast.error("File too large. Max 50 MB.");
        return;
      }
      setLoading(true);
      try {
        const doc = await buildDocumentFromFile(file);
        loadDocument(doc);
      } catch (e) {
        console.error(e);
        toast.error("Could not read that PDF.");
      } finally {
        setLoading(false);
      }
    },
    [loadDocument],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
  });

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-6 py-12">
      <div className="mb-10 text-center">
        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <FileText className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">PDF Editor</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Upload a PDF to edit text, add shapes, annotate, sign, and export — all in your browser.
        </p>
      </div>

      <div
        {...getRootProps()}
        className={`w-full cursor-pointer rounded-2xl border-2 border-dashed p-16 text-center transition-colors ${
          isDragActive ? "border-primary bg-accent" : "border-border bg-surface hover:bg-accent/50"
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">
          {loading
            ? "Loading…"
            : isDragActive
              ? "Drop the PDF here"
              : "Drop a PDF here, or click to browse"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">PDF only · up to 50 MB</p>
      </div>

      {onRestore ? (
        <button
          onClick={onRestore}
          className="mt-6 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Resume last document
        </button>
      ) : null}
    </div>
  );
}
