import fs from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { AiError } from "../errors";
import { pdfJsAssets, RENDER_FAILED, renderPdfPages } from "./render";

/** A letter portrait page with text (Helvetica, not embedded: pdf.js loads its standard font data) and a landscape page. */
async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Q1: 42", { x: 72, y: 700, size: 36, font });
  doc.addPage([792, 612]).drawText("Q2: x = 3", { x: 72, y: 500, size: 36, font });
  return doc.save();
}

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("renderPdfPages", () => {
  it("renders every page, in order, to a PNG whose longer side is the max edge", async () => {
    const pdf = await twoPagePdf();
    const copy = pdf.slice();
    const pages = await renderPdfPages(pdf, { maxEdge: 800, maxPages: 10 });

    expect(pages).toHaveLength(2);
    expect(pages.map((p) => [p.width, p.height])).toEqual([[618, 800], [800, 618]]);
    for (const page of pages) {
      expect([...page.png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(pngSize(page.png)).toEqual({ width: page.width, height: page.height });
      expect(Math.max(page.width, page.height)).toBeLessThanOrEqual(800);
    }
    // The caller's bytes are left as they were.
    expect(pdf).toEqual(copy);
  });

  it("draws the page: a page with text is not blank", async () => {
    const [page] = await renderPdfPages(await twoPagePdf(), { maxEdge: 400, maxPages: 10 });
    const blank = await renderPdfPages(await (async () => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      return doc.save();
    })(), { maxEdge: 400, maxPages: 10 });
    expect(page.png.byteLength).toBeGreaterThan(blank[0].png.byteLength);
  });

  it("refuses a PDF with more pages than allowed", async () => {
    const err = await renderPdfPages(await twoPagePdf(), { maxEdge: 400, maxPages: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: "request_too_large", o: { retryable: false } });
  });

  it("fails without retrying on bytes that are not a PDF", async () => {
    const err = await renderPdfPages(new TextEncoder().encode("%PDF-1.7 not really"), { maxEdge: 400, maxPages: 10 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "bad_request", message: RENDER_FAILED, o: { retryable: false } });
  });

  it("points pdf.js at its own data folders, each ending in the \"/\" it requires (also on Windows)", () => {
    for (const dir of Object.values(pdfJsAssets())) {
      expect(dir.endsWith("/")).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
  });

  it("stops between pages when the job is aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const err = await renderPdfPages(await twoPagePdf(), { maxEdge: 400, maxPages: 10, signal: abort.signal }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "aborted", o: { retryable: true } });
  });
});
