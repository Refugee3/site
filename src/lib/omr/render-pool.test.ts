import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { renderPdfPages } from "@/lib/ai/ollama/render";
import { resetConfigForTests } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { makeMarkedPaper, makeWorksheet, PLANTS_QUIZ } from "./fixtures";
import { openPdf } from "./pdf-raster";
import { readAhead, renderThreads } from "./render-pool";

function useThreads(n: number): void {
  vi.stubEnv("RENDER_THREADS", String(n));
  resetConfigForTests();
}

interface PoolInternals {
  broken: boolean;
  threads: Array<{ worker: { terminate(): Promise<number> }; job: unknown; ready: boolean }>;
}

const POOL = Symbol.for("pag.render-pool");

function pool(): PoolInternals {
  const p = (globalThis as unknown as Record<symbol, PoolInternals | undefined>)[POOL];
  if (!p) throw new Error("no render pool");
  return p;
}

/** A vector page (a marked, slightly rotated worksheet) and a scanned page (a JPEG of drawn marks and text). */
async function mixedPdf(): Promise<Uint8Array> {
  const worksheet = await makeWorksheet(PLANTS_QUIZ);
  const paper = await makeMarkedPaper(worksheet, [{ q: "1", circle: "B" }], { warp: { rotate: 0.8, dx: 4 }, name: "Ada Lovelace" });
  const doc = await PDFDocument.load(paper);
  const canvas = createCanvas(850, 1100);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, 850, 1100);
  ctx.fillStyle = "#222";
  ctx.font = "28px sans-serif";
  ctx.fillText("Name: Grace Hopper", 60, 90);
  ctx.lineWidth = 3;
  for (let k = 0; k < 6; k++) {
    ctx.beginPath();
    ctx.ellipse(120 + k * 110, 300 + k * 90, 40, 22, 0.2 * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  const jpg = await doc.embedJpg(await canvas.encode("jpeg", 80));
  doc.addPage([612, 792]).drawImage(jpg, { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}

async function grays(pdf: Uint8Array) {
  const doc = await openPdf(pdf);
  try {
    return await Promise.all([
      doc.renderGray(1, { dpi: 150 }), doc.renderGray(2, { dpi: 200 }), doc.renderGray(1, { widthPx: 1001 }), doc.renderGray(2, { widthPx: 640 }),
    ]);
  } finally {
    await doc.close();
  }
}

describe("rendering in worker threads", () => {
  it("gives the same gray pixels as rendering in-process", async () => {
    const pdf = await mixedPdf();
    useThreads(0);
    const inProcess = await grays(pdf);
    useThreads(2);
    const inWorkers = await grays(pdf);

    expect(pool().broken).toBe(false);
    expect(pool().threads.length).toBeGreaterThan(0);
    expect(pool().threads.length).toBeLessThanOrEqual(2);
    expect(inWorkers.map((g) => [g.width, g.height])).toEqual(inProcess.map((g) => [g.width, g.height]));
    for (let k = 0; k < inProcess.length; k++) {
      expect(inWorkers[k].data instanceof Uint8Array).toBe(true);
      expect(Buffer.compare(Buffer.from(inWorkers[k].data), Buffer.from(inProcess[k].data)), `render ${k}`).toBe(0);
    }
    // The scanned page has ink: not a blank canvas that happens to match.
    expect(inProcess[1].data.some((v) => v < 100)).toBe(true);
  });

  it("gives the same PNG page images for the local model", async () => {
    const pdf = await mixedPdf();
    useThreads(0);
    const inProcess = await renderPdfPages(pdf, { maxEdge: 900, maxPages: 10 });
    useThreads(2);
    const inWorkers = await renderPdfPages(pdf, { maxEdge: 900, maxPages: 10 });
    expect(inWorkers.map((p) => [p.width, p.height])).toEqual(inProcess.map((p) => [p.width, p.height]));
    for (let k = 0; k < inProcess.length; k++) expect(Buffer.compare(Buffer.from(inWorkers[k].png), Buffer.from(inProcess[k].png))).toBe(0);
  });

  it("rejects a page that doesn't exist, and renders after close", async () => {
    useThreads(2);
    const doc = await openPdf(await mixedPdf());
    await expect(doc.renderGray(3, { dpi: 50 })).rejects.toThrow();
    expect((await doc.renderGray(1, { dpi: 50 })).width).toBe(Math.round((612 * 50) / 72));
    await doc.close();
    await expect(doc.renderGray(1, { dpi: 50 })).rejects.toThrow();
  });

  it("fails a render as an unreadable PDF when its worker dies, and starts another worker", async () => {
    useThreads(1);
    const pdf = await mixedPdf();
    const doc = await openPdf(pdf);
    try {
      await doc.renderGray(1, { dpi: 50 });
      const [thread] = pool().threads;
      expect(thread.ready).toBe(true);
      const render = doc.renderGray(2, { dpi: 300 });
      expect(thread.job).not.toBeNull();
      await thread.worker.terminate();
      const err = await render.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("invalid_pdf");

      const again = await doc.renderGray(2, { dpi: 50 });
      expect(again.width).toBe(Math.round((612 * 50) / 72));
      expect(pool().threads).toHaveLength(1);
      expect(pool().threads[0]).not.toBe(thread);
    } finally {
      await doc.close();
    }
  });

  it("renders in-process when the worker script is missing", async () => {
    const pdf = await mixedPdf();
    useThreads(0);
    const [expected] = await grays(pdf);
    useThreads(2);
    // An app folder with node_modules (pdf.js finds its data files there) but no workers/ folder.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-pool-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"), "junction");
    const slots = globalThis as unknown as Record<symbol, unknown>;
    const saved = slots[POOL];
    delete slots[POOL];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const doc = await openPdf(pdf);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      const [first, second] = await Promise.all([doc.renderGray(1, { dpi: 150 }), doc.renderGray(1, { dpi: 150 })]);
      expect(Buffer.compare(Buffer.from(first.data), Buffer.from(expected.data))).toBe(0);
      expect(Buffer.compare(Buffer.from(second.data), Buffer.from(expected.data))).toBe(0);
      expect(pool().broken).toBe(true);
      expect(quiet).toHaveBeenCalledTimes(1);
    } finally {
      cwd.mockRestore();
      quiet.mockRestore();
      await doc.close();
      slots[POOL] = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chooses one thread per core but one, at most 8, unless RENDER_THREADS says", () => {
    useThreads(5);
    expect(renderThreads()).toBe(5);
    vi.stubEnv("RENDER_THREADS", "");
    resetConfigForTests();
    expect(renderThreads()).toBeGreaterThanOrEqual(0);
    expect(renderThreads()).toBeLessThanOrEqual(8);
  });
});

describe("readAhead", () => {
  it("starts up to `ahead` items past the one taken, each once, and returns them in order", async () => {
    const started: number[] = [];
    const take = readAhead(5, 2, async (i) => {
      started.push(i);
      return i * 10;
    });
    expect(await take(1)).toBe(10);
    expect(started).toEqual([1, 2, 3]);
    expect(await take(2)).toBe(20);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(await take(3)).toBe(30);
    expect(await take(4)).toBe(40);
    expect(await take(5)).toBe(50);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });

  it("starts each item only when taken with ahead 0, and passes a failure to its taker", async () => {
    const started: number[] = [];
    const take = readAhead(3, 0, async (i) => {
      started.push(i);
      if (i === 2) throw new Error("bad page");
      return i;
    });
    expect(await take(1)).toBe(1);
    expect(started).toEqual([1]);
    await expect(take(2)).rejects.toThrow("bad page");
    expect(started).toEqual([1, 2]);
  });
});
