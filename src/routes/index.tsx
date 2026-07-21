import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { useEditor } from "@/lib/editor/store";
import { UploadDropzone } from "@/components/editor/UploadDropzone";
import { Editor } from "@/components/editor/Editor";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "PDF Editor — edit PDFs in your browser" },
      {
        name: "description",
        content:
          "A fast, private, in-browser PDF editor. Add text, shapes, drawings, highlights, images, and signatures, then export a flattened PDF.",
      },
      { property: "og:title", content: "PDF Editor" },
      {
        property: "og:description",
        content:
          "Edit PDFs entirely in your browser — text, shapes, annotations, pages, and signatures.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const doc = useEditor((s) => s.doc);
  const restore = useEditor((s) => s.restore);
  const [checked, setChecked] = useState(false);
  const [canRestore, setCanRestore] = useState(false);

  useEffect(() => {
    if (checked) return;
    (async () => {
      const ok = await restore();
      setCanRestore(!ok && false); // if restore succeeded we're already loaded; button only appears if not
      setChecked(true);
    })();
  }, [checked, restore]);

  return (
    <>
      {doc ? <Editor /> : <UploadDropzone onRestore={canRestore ? () => restore() : undefined} />}
      <Toaster position="bottom-right" />
    </>
  );
}
