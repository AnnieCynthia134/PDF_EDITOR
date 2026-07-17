// Temporary smoke test for exporter embedded-font handling. Deleted after run.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { exportPdf } from "./src/lib/editor/exporter";
import type { DocumentState } from "./src/lib/editor/types";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

async function listBaseFonts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const names: string[] = [];
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fonts) continue;
    for (const [k] of fonts.entries()) {
      const fd = fonts.lookupMaybe(k, PDFDict);
      const bf = fd?.lookupMaybe(PDFName.of("BaseFont"), PDFName)?.decodeText();
      if (bf) names.push(bf);
    }
  }
  return names;
}

async function main() {
  // 1) Source PDF with a subsetted embedded TrueType font (Arial)
  const arial = readFileSync("C:/Windows/Fonts/arial.ttf");
  const src = await PDFDocument.create();
  src.registerFontkit(fontkit);
  const f = await src.embedFont(arial, { subset: true });
  const p = src.addPage([612, 792]);
  p.drawText("Hello Original 123", { x: 72, y: 700, size: 24, font: f });
  const srcBytes = await src.save();
  const dataUrl =
    "data:application/pdf;base64," + Buffer.from(srcBytes).toString("base64");

  const mkDoc = (newStr: string): DocumentState => ({
    fileName: "t.pdf",
    fileDataUrl: dataUrl,
    pages: [{ id: "p1", sourceIndex: 0, rotation: 0, width: 612, height: 792 }],
    objects: [],
    textEdits: [
      {
        page: 0,
        key: "t0",
        origStr: "Hello Original 123",
        newStr,
        x: 72 / 612,
        y: (792 - 700 - 24) / 792,
        w: 220 / 612,
        h: 24 / 792,
        fontSize: 24,
        fontFamily: '"g_d0_f1", "ArialMT", "Arial", sans-serif',
        bold: false,
        italic: false,
        color: "#112233",
        bgColor: "#ffffff",
        baseline: (792 - 700) / 792,
      },
    ],
  });

  // 2) New text uses only glyphs present in the subset -> original face reused.
  // The copied source page already carries one ArialMT subset font; our
  // re-embed for the edit adds a second one.
  const out1 = await exportPdf(mkDoc("Hello 321"));
  const fonts1 = await listBaseFonts(out1);
  console.log("fonts (covered):", fonts1.join(", "));
  const arialCount1 = fonts1.filter((n) => /ArialMT/i.test(n)).length;
  assert(arialCount1 >= 2, `original Arial face re-embedded for the edit (found ${arialCount1} ArialMT fonts)`);

  // 3) New text contains 'Z' which the subset lacks -> standard-font fallback,
  // no crash, and no second Arial embed.
  const out2 = await exportPdf(mkDoc("HZ 321"));
  const fonts2 = await listBaseFonts(out2);
  console.log("fonts (fallback):", fonts2.join(", "));
  const arialCount2 = fonts2.filter((n) => /ArialMT/i.test(n)).length;
  assert(arialCount2 === 1, `subset lacking glyphs falls back to a standard font (found ${arialCount2} ArialMT fonts)`);
  assert(fonts2.some((n) => /Helvetica/i.test(n)), "fallback used Helvetica");

  // 4) Squeeze path: much longer text (all glyphs available) still exports
  const out3 = await exportPdf(mkDoc("Hello Hello Hello Hello Hello Hello 123 123"));
  assert(out3.length > 0, "long text with Tz squeeze exports");

  console.log("ALL PASS");
}

main().catch((err) => {
  console.error("FAIL (exception):", err);
  process.exit(1);
});
