import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { detectIdentitySpots, TOP_STRIP } from "./identity-zones";
import { openPdf } from "./pdf-raster";
import type { TextPage } from "./text-zones";

/** A one-page worksheet with these lines of text at the top (each line: x in points, text), a question below. */
async function worksheet(lines: Array<Array<[number, string]>>): Promise<TextPage[]> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Unit 4 Quiz", { x: 72, y: 740, size: 18, font });
  lines.forEach((line, i) => {
    for (const [x, text] of line) page.drawText(text, { x, y: 700 - i * 30, size: 12, font });
  });
  page.drawText("1. Write your name on every page before you start.", { x: 72, y: 560, size: 12, font });
  const pdf = await openPdf(await doc.save());
  try {
    const size = await pdf.pageSize(1);
    return [{ tokens: await pdf.textTokens(1), widthPt: size.width, heightPt: size.height }];
  } finally {
    await pdf.close();
  }
}

/** A box in points from the top left, for readable expectations. */
function inPoints(b: { x: number; y: number; w: number; h: number }) {
  return { x0: Math.round(b.x * 612), x1: Math.round((b.x + b.w) * 612), y0: Math.round(b.y * 792), y1: Math.round((b.y + b.h) * 792) };
}

describe("identity spots from a blank's text layer", () => {
  it("finds the name and period after their labels, each up to the end of its blank", async () => {
    const pages = await worksheet([[[72, "Name: ____________________   Period: ____"]]]);
    const spots = detectIdentitySpots(pages);
    expect(spots.map((s) => [s.kind, s.label, s.itemLabel, s.page])).toEqual([["name", "Name", null, 1], ["section", "Period", null, 1]]);
    const name = inPoints(spots[0].boxes[0]);
    const period = inPoints(spots[1].boxes[0]);
    // To the right of "Name:" (72 + its width), up to the blank's end, and above the line (baseline at 92 pt from the top).
    expect(name.x0).toBeGreaterThan(100);
    expect(name.x1).toBeLessThan(period.x0);
    expect(name.y0).toBeLessThan(92 - 15);
    expect(name.y1).toBeGreaterThan(92);
    expect(period.x0).toBeGreaterThan(name.x1);
    expect(period.x1 - period.x0).toBeGreaterThan(20);
  });

  it("reads Section, Class, Block or Hour as the class, stops the name at the Date label, and finds each kind once", async () => {
    const spots = detectIdentitySpots(await worksheet([
      [[72, "Name ______________"], [300, "Date: ________"]],
      [[72, "Class: _______"], [300, "Section: ____"]],
    ]));
    expect(spots.map((s) => [s.kind, s.label])).toEqual([["name", "Name"], ["section", "Class"]]);
    expect(inPoints(spots[0].boxes[0]).x1).toBeLessThan(300);
  });

  it("a label with room after it gets that room; one at the text's right edge gets the line below it", async () => {
    const after = detectIdentitySpots(await worksheet([[[72, "Student name:"]]]));
    expect(after.map((s) => s.kind)).toEqual(["name"]);
    const right = inPoints(after[0].boxes[0]);
    expect(right.x0).toBeGreaterThan(140);
    expect(right.y1).toBeGreaterThan(92);
    expect(right.y0).toBeLessThan(92);

    const below = detectIdentitySpots(await worksheet([[[330, "Name:"]]]));
    expect(below).toHaveLength(1);
    const box = inPoints(below[0].boxes[0]);
    expect(box.x0).toBeLessThanOrEqual(331);
    expect(box.y0).toBeGreaterThan(92);
  });

  it("finds nothing on a page without such labels; a sentence that mentions a name is not a label", async () => {
    expect(detectIdentitySpots(await worksheet([[[72, "Read each question carefully."]]]))).toEqual([]);
    expect(detectIdentitySpots([])).toEqual([]);
    expect(TOP_STRIP).toEqual({ x: 0, y: 0, w: 1, h: 0.2 });
  });
});
