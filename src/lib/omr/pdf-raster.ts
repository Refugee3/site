import "server-only";
import { createCanvas } from "@napi-rs/canvas";
import { pdfJsAssets } from "@/lib/ai/ollama/render";
import { AppError } from "@/lib/errors";
import { grayFromRgba } from "./image";
import { pooledPdf, RenderFailed, RenderPoolUnavailable } from "./render-pool";
import type { TextToken } from "./text-zones";
import type { GrayImage } from "./types";

// PDF pages as grayscale pixels (mark detection), as PNG (the zone editor, the review page's crops) and as positioned text
// (finding the answer spots on a digital blank). pdf.js draws on @napi-rs/canvas, as for the Ollama engine. Pages are drawn
// in worker threads when there are any (render-pool.ts); sizes and text are read here.

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsModule: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsModule;
}

export interface PageSize {
  /** In PDF points (1/72 in), as displayed (rotation applied). */
  width: number;
  height: number;
}

export interface OpenPdf {
  numPages: number;
  pageSize(page: number): Promise<PageSize>;
  /** The page in gray at `dpi`, or scaled so its width is `widthPx`. */
  renderGray(page: number, o: { dpi: number } | { widthPx: number }): Promise<GrayImage>;
  /** The page's text, word by word, in normalized page coordinates (empty for a scan). */
  textTokens(page: number): Promise<TextToken[]>;
  close(): Promise<void>;
}

const UNREADABLE = "This PDF couldn't be read to find the answer spots.";

/** Opens a PDF for rendering; `fonts` loads font names too (needed to recognize check boxes drawn with symbol fonts). */
export async function openPdf(bytes: Uint8Array, o: { fonts?: boolean } = {}): Promise<OpenPdf> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...pdfJsAssets(), verbosity: 0, fontExtraProperties: o.fonts ?? false });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy().catch(() => undefined);
    throw new AppError("invalid_pdf", UNREADABLE);
  }
  const factory = doc.canvasFactory as { create(w: number, h: number): { canvas: unknown; context: CanvasLike } };
  const pooled = pooledPdf(bytes);

  return {
    numPages: doc.numPages,
    async pageSize(n) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    },
    async renderGray(n, opts) {
      if (pooled) {
        try {
          return await pooled.render("dpi" in opts ? { op: "gray", page: n, dpi: opts.dpi } : { op: "gray", page: n, widthPx: opts.widthPx });
        } catch (e) {
          if (e instanceof RenderFailed) throw new AppError("invalid_pdf", UNREADABLE);
          if (!(e instanceof RenderPoolUnavailable)) throw e;
        }
      }
      const page = await doc.getPage(n);
      try {
        const unscaled = page.getViewport({ scale: 1 });
        const scale = "dpi" in opts ? opts.dpi / 72 : opts.widthPx / unscaled.width;
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        const { canvas, context } = factory.create(width, height);
        await page.render({ canvas: canvas as HTMLCanvasElement, viewport, background: "white" }).promise;
        const pixels = context.getImageData(0, 0, width, height).data;
        return grayFromRgba(pixels, width, height);
      } finally {
        page.cleanup();
      }
    },
    async textTokens(n) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      let symbolFonts = new Set<string>();
      if (o.fonts) {
        await page.getOperatorList();
        symbolFonts = new Set(Object.keys(content.styles).filter((name) => {
          try {
            const font = page.commonObjs.get(name) as { name?: string } | undefined;
            return /dingbat|wingding|webding|symbol/i.test(font?.name ?? "");
          } catch {
            return false;
          }
        }));
      }
      const tokens: TextToken[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        const m = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
        const fontHeight = Math.hypot(m[2], m[3]);
        // Upright text only; rotated text (a sideways label) is not an answer spot.
        if (fontHeight <= 0 || Math.abs(m[1]) > 0.01 * fontHeight) continue;
        const width = item.width * (viewport.scale ?? 1);
        tokens.push(...splitItem({
          str: item.str,
          x: m[4] / viewport.width,
          baseline: m[5] / viewport.height,
          width: width / viewport.width,
          fontHeight: fontHeight / viewport.height,
          symbolic: symbolFonts.has(item.fontName),
        }));
      }
      page.cleanup();
      return tokens;
    },
    async close() {
      pooled?.close();
      await task.destroy().catch(() => undefined);
    },
  };
}

interface CanvasLike {
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

/**
 * One text item as words (and runs of underscores, and check-box glyphs) with their estimated boxes: pdf.js gives an item's
 * start and width, so each character gets an equal share of it (close enough with the padding around every spot).
 */
export function splitItem(i: { str: string; x: number; baseline: number; width: number; fontHeight: number; symbolic: boolean }): TextToken[] {
  // "[ ]" and "( )" are check boxes; they keep their length, so the positions of what follows stay right.
  const text = i.str.replace(/\[\s?\]|\(\s{1,2}\)/g, (m) => `☐${" ".repeat(m.length - 1)}`);
  const length = [...text].length;
  const per = length === 0 ? 0 : i.width / length;
  // UTF-16 index → code point index (a symbol outside the BMP is one character on the page).
  const codePointAt: number[] = [];
  for (let k = 0, cp = 0; k < text.length; cp++) {
    codePointAt[k] = cp;
    k += text.codePointAt(k)! > 0xffff ? 2 : 1;
  }
  const out: TextToken[] = [];
  for (const m of text.matchAll(/☐|_{3,}|[^\s_☐]+|_{1,2}/gu)) {
    const start = codePointAt[m.index];
    const chars = [...m[0]].length;
    let word = m[0];
    // Symbol fonts (Wingdings, ZapfDingbats) draw boxes and circles with plain letters; Unicode has its own box glyphs.
    if (i.symbolic && /^[omnlq¨]$/.test(word)) word = "☐";
    if (BOX_GLYPH.test(word)) word = "☐";
    out.push({
      text: word, x: i.x + start * per, y: i.baseline - i.fontHeight * 0.8, w: Math.max(per * chars, 1e-4), h: i.fontHeight, baseline: i.baseline,
    });
  }
  return out;
}

/** Check boxes and bubbles: ☐ ☑ ☒ □ ▢ ○ ◯ ◻ ◽ ❍ ❏ ❑ ⬜ ⚪, and Wingdings' private-use box and circle codes. */
const BOX_GLYPH = /^[\u2610\u2611\u2612\u25a1\u25a2\u25cb\u25ef\u25fb\u25fd\u274d\u274f\u2751\u2b1c\u26aa\uf06f\uf0a8\uf071\uf06d]$/u;

/** A gray image as PNG bytes. */
export async function grayToPng(img: GrayImage): Promise<Uint8Array> {
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(img.width, img.height);
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
    data.data[j] = data.data[j + 1] = data.data[j + 2] = img.data[i];
    data.data[j + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return new Uint8Array(await canvas.encode("png"));
}

export interface Outline {
  /** Corners in the image's pixels (a quadrilateral: a rotated box stays exact). */
  points: Array<[number, number]>;
  color: string;
  width: number;
}

/** A gray image as PNG with outlines drawn over it (the detected option on the review page's crop). */
export async function grayToPngWithOutlines(img: GrayImage, outlines: Outline[]): Promise<Uint8Array> {
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(img.width, img.height);
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
    data.data[j] = data.data[j + 1] = data.data[j + 2] = img.data[i];
    data.data[j + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  for (const o of outlines) {
    if (o.points.length < 2) continue;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = o.width;
    ctx.beginPath();
    ctx.moveTo(o.points[0][0], o.points[0][1]);
    for (const [x, y] of o.points.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.stroke();
  }
  return new Uint8Array(await canvas.encode("png"));
}
