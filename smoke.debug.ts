// Temporary debug probe. Deleted after run.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

async function main() {
  const arial = readFileSync("C:/Windows/Fonts/arial.ttf");
  const src = await PDFDocument.create();
  src.registerFontkit(fontkit);
  const f = await src.embedFont(arial, { subset: true });
  const p = src.addPage([612, 792]);
  p.drawText("Hello Original 123", { x: 72, y: 700, size: 24, font: f });
  const bytes = await src.save();
  const doc = await PDFDocument.load(bytes);
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fonts) { console.log("no fonts dict"); continue; }
    for (const [k] of fonts.entries()) {
      const fd = fonts.lookupMaybe(k, PDFDict);
      if (!fd) { console.log(k.asString(), "-> not a dict"); continue; }
      const subtype = fd.lookupMaybe(PDFName.of("Subtype"), PDFName);
      console.log("font key:", k.asString(), "| Subtype asString:", JSON.stringify(subtype?.asString()), "| decodeText:", JSON.stringify(subtype?.decodeText()));
      const bf = fd.lookupMaybe(PDFName.of("BaseFont"), PDFName);
      console.log("  BaseFont:", JSON.stringify(bf?.decodeText()));
      const desc = fd.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray)?.lookup(0, PDFDict);
      console.log("  descendant:", !!desc);
      const target = desc ?? fd;
      const descriptor = target.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
      console.log("  descriptor:", !!descriptor);
      if (descriptor) {
        const ff2 = descriptor.lookup(PDFName.of("FontFile2"));
        console.log("  FontFile2 instanceof PDFRawStream:", ff2 instanceof PDFRawStream, "| ctor:", ff2?.constructor?.name);
        const fn = descriptor.lookupMaybe(PDFName.of("FontName"), PDFName);
        console.log("  FontName:", JSON.stringify(fn?.decodeText()));
        const tbf = target.lookupMaybe(PDFName.of("BaseFont"), PDFName);
        console.log("  target BaseFont:", JSON.stringify(tbf?.decodeText()));
      }
    }
  }
}
main();
