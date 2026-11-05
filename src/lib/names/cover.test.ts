import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { COVER_MARGIN, coverPages, markToPixels, newAnonId, pagesToPdf } from "./cover";

async function blackPage(width: number, height: number): Promise<Uint8Array> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(await canvas.encode("png"));
}

async function pixel(bytes: Uint8Array, width: number, height: number, x: number, y: number): Promise<number> {
  const img = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(x, y, 1, 1).data[0];
}

describe("covering names", () => {
  it("turns ChatGPT's thousandths into padded pixel boxes kept on the page", () => {
    expect(markToPixels({ page: 1, kind: "name", x_min: 100, y_min: 100, x_max: 300, y_max: 150 }, 1000, 2000, 0))
      .toEqual({ x: 100, y: 200, w: 200, h: 100 });
    const edge = markToPixels({ page: 1, kind: "name", x_min: 990, y_min: 0, x_max: 1010, y_max: 10 }, 1000, 1000);
    expect(edge.x + edge.w).toBeLessThanOrEqual(1000);
    expect(edge.y).toBe(0);
    expect(COVER_MARGIN).toBeGreaterThan(0);
  });

  it("whites out each box on its page only, and builds a PDF of the covered pages", async () => {
    const pages = await Promise.all([1, 2].map(async () => ({ bytes: await blackPage(400, 500), width: 400, height: 500 })));
    const covered = await coverPages(pages, [{ page: 1, kind: "name", x_min: 100, y_min: 100, x_max: 900, y_max: 200 }], "S-123456");

    expect(await pixel(covered[0].bytes, 400, 500, 360, 50)).toBeGreaterThan(200); // inside the box, clear of the label
    expect(await pixel(covered[0].bytes, 400, 500, 200, 400)).toBeLessThan(50); // the rest of page 1
    expect(await pixel(covered[1].bytes, 400, 500, 200, 75)).toBeLessThan(50); // page 2 untouched

    const pdf = await PDFDocument.load(await pagesToPdf(covered));
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPage(0).getWidth()).toBe(612);
  });

  it("gives each paper an ID not used yet in the assignment", () => {
    const values = [0.1, 0.1, 0.5];
    const id = newAnonId(new Set(["S-190000"]), () => values.shift()!);
    expect(id).toBe("S-550000");
  });
});
