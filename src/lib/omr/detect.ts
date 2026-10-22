import "server-only";
import { AiError } from "@/lib/ai/errors";
import type { AnswerSpots, DetectedSpot, SpotDetection } from "@/lib/ai/grader";
import { extractPageSets } from "@/lib/storage/pdf";
import { readChoice, readWriteIn } from "./decide";
import { addedInk, type CoveredBlank, coverBlank, OMR_DPI, studentInkMask } from "./ink";
import { grayToPng, openPdf } from "./pdf-raster";
import { applyAffine, type PreparedPage, prepareBlankPage, registerPage } from "./register";
import { clampBox } from "./text-zones";
import type { GrayImage, QuestionSpots, SpotBox, SpotEvidence } from "./types";

// Mark detection on a paper (server side): render the blank and the paper's pages at OMR_DPI, line each paper page up with
// its blank page, measure the ink the student added in every answer spot, read choices and blanks from it, and crop written
// spots (at CROP_DPI) for the AI to transcribe. Pure image code apart from pdf.js rendering.

/** Written spots are cropped from the paper rendered at this density, for the AI to read. */
export const CROP_DPI = 200;
/** Margin around a spot's crop (inches): the start of a word written past the line, or a circle drawn wide. */
const CROP_MARGIN_IN = 0.15;
/** The page's aspect ratio may differ from the blank's by this much (a scan cropped a little, A4 vs Letter). */
const MAX_ASPECT_CHANGE = 0.12;

interface PreparedBlankPage {
  gray: GrayImage;
  prepared: PreparedPage;
  covered: CoveredBlank;
  widthPt: number;
  heightPt: number;
}

export interface PreparedWorksheet {
  sha: string;
  pages: PreparedBlankPage[];
}

const SLOT = Symbol.for("pag.worksheets");
type Cache = Map<string, Promise<PreparedWorksheet>>;
const slots = globalThis as unknown as Record<symbol, Cache | undefined>;
/** Blank worksheets kept rendered (each page ~10 MB of pixels and masks). */
const CACHED = 2;

/** The blank worksheet rendered and prepared for registration, cached by its content hash. */
export function prepareWorksheet(pdf: Uint8Array, sha: string): Promise<PreparedWorksheet> {
  const cache: Cache = (slots[SLOT] ??= new Map());
  const hit = cache.get(sha);
  if (hit) {
    cache.delete(sha);
    cache.set(sha, hit);
    return hit;
  }
  const prepared = (async () => {
    const doc = await openPdf(pdf);
    try {
      const pages: PreparedBlankPage[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const size = await doc.pageSize(n);
        const gray = await doc.renderGray(n, { dpi: OMR_DPI });
        pages.push({ gray, prepared: prepareBlankPage(gray), covered: coverBlank(gray), widthPt: size.width, heightPt: size.height });
      }
      return { sha, pages };
    } finally {
      await doc.close();
    }
  })();
  prepared.catch(() => cache.delete(sha));
  cache.set(sha, prepared);
  while (cache.size > CACHED) cache.delete(cache.keys().next().value!);
  return prepared;
}

export interface SpotPlanEntry {
  ref: string;
  spot: QuestionSpots;
}

/** Mark detection for an assignment: the plan (which spots answer which item) over its blank worksheet. */
export function answerSpots(o: { blankPdf: () => Promise<Uint8Array>; sha: string; plan: SpotPlanEntry[] }): AnswerSpots {
  return {
    refs: o.plan.map((p) => p.ref),
    async read(pdf, pages, opts) {
      const worksheet = await prepareWorksheet(await o.blankPdf(), o.sha);
      return readPaperSpots({ paperPdf: pdf, pages, worksheet, plan: o.plan, signal: opts.signal });
    },
  };
}

const UNALIGNED = "Couldn't line up this paper with the blank worksheet, so the AI read every question.";

/** Reads every planned spot on the paper (its `pages` within `paperPdf`, in order). */
export async function readPaperSpots(i: {
  paperPdf: Uint8Array; pages: number[]; worksheet: PreparedWorksheet; plan: SpotPlanEntry[]; signal?: AbortSignal;
}): Promise<SpotDetection> {
  const { worksheet } = i;
  if (i.pages.length !== worksheet.pages.length) {
    return {
      ok: false, reason: "page_count",
      note: `This paper has ${i.pages.length} page${i.pages.length === 1 ? "" : "s"} and the blank worksheet ${worksheet.pages.length}, `
        + "so its marks weren't read from the answer spots; the AI read every question.",
    };
  }
  const doc = await openPdf(i.paperPdf);
  try {
    const needed = [...new Set(i.plan.map((p) => p.spot.page))].filter((page) => page >= 1 && page <= worksheet.pages.length);
    const lined = new Map<number, { reg: ReturnType<typeof registerPage>; ink: ReturnType<typeof studentInkMask> }>();
    for (const page of needed) {
      if (i.signal?.aborted) throw new AiError("aborted", "Stopped while reading the answer spots.", { retryable: true });
      const blank = worksheet.pages[page - 1];
      const size = await doc.pageSize(i.pages[page - 1]);
      const aspectChange = Math.abs(size.height / size.width - blank.heightPt / blank.widthPt) / (blank.heightPt / blank.widthPt);
      if (aspectChange > MAX_ASPECT_CHANGE) return { ok: false, reason: "unaligned", note: UNALIGNED };
      // Rendered as wide as the blank, so registration only has to find small changes of scale.
      const student = await doc.renderGray(i.pages[page - 1], { widthPx: blank.gray.width });
      const reg = registerPage(blank.prepared, student);
      if (!reg.ok) return { ok: false, reason: "unaligned", note: UNALIGNED };
      lined.set(page, { reg, ink: studentInkMask(student) });
    }

    const items: DetectedSpot[] = [];
    const crops: Array<{ index: number; page: number; box: SpotBox }> = [];
    for (const { ref, spot } of i.plan) {
      const at = lined.get(spot.page);
      if (!at) continue;
      const blank = worksheet.pages[spot.page - 1];
      const marginX = (CROP_MARGIN_IN * 72) / blank.widthPt;
      const marginY = (CROP_MARGIN_IN * 72) / blank.heightPt;
      const crop = padBox(unionBox(spot.kind === "choice" ? spot.options.map((o) => o.box) : spot.boxes), marginX, marginY);
      const evidence: SpotEvidence = { kind: spot.kind, page: spot.page, crop, map: at.reg.map };
      if (spot.kind === "choice") {
        const options = spot.options.map((o) => ({ value: o.value, box: o.box, ink: addedInk(blank.covered, at.ink, at.reg.px, o.box).fraction }));
        items.push({
          ref, kind: "choice", values: spot.options.map((o) => o.value), multi: spot.multi,
          evidence: { ...evidence, options: options.map((o) => ({ ...o, ink: round4(o.ink) })) },
          choice: readChoice(options),
        });
        continue;
      }
      let pixels = 0;
      let area = 0;
      for (const box of spot.boxes) {
        const score = addedInk(blank.covered, at.ink, at.reg.px, box);
        pixels += score.pixels;
        area += score.area;
      }
      const fraction = area > 0 ? pixels / area : 0;
      const written = readWriteIn(pixels, fraction);
      items.push({
        ref, kind: spot.kind, values: [], multi: false, evidence: { ...evidence, boxes: spot.boxes, ink: round4(fraction) }, written,
      });
      if (written.written) crops.push({ index: items.length - 1, page: spot.page, box: crop });
    }

    // Written spots: crops at CROP_DPI, one render per page that has any.
    for (const page of [...new Set(crops.map((c) => c.page))]) {
      const blank = worksheet.pages[page - 1];
      const hi = await doc.renderGray(i.pages[page - 1], { widthPx: Math.round((blank.widthPt / 72) * CROP_DPI) });
      const map = lined.get(page)!.reg.map;
      for (const c of crops.filter((x) => x.page === page)) {
        const img = cropMapped(hi, map, c.box);
        items[c.index].crop = { png: await grayToPng(img), width: img.width, height: img.height };
      }
    }
    const [identityPdf] = await extractPageSets(i.paperPdf, [[i.pages[0]]]);
    return { ok: true, items, identityPdf };
  } finally {
    await doc.close();
  }
}

/** The part of a paper page (rendered as `img`) where a blank box lands: the bounding box of its four mapped corners. */
export function cropMapped(img: GrayImage, map: SpotEvidence["map"], box: SpotBox): GrayImage {
  const r = mappedRect(map, box);
  const x0 = Math.max(0, Math.floor(r.x * img.width));
  const y0 = Math.max(0, Math.floor(r.y * img.height));
  const x1 = Math.min(img.width, Math.ceil((r.x + r.w) * img.width));
  const y1 = Math.min(img.height, Math.ceil((r.y + r.h) * img.height));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const data = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height && y0 + y < img.height; y++) {
    data.set(img.data.subarray((y0 + y) * img.width + x0, (y0 + y) * img.width + x0 + Math.min(width, img.width - x0)), y * width);
  }
  return { width, height, data };
}

/** A blank box mapped onto the paper page: the bounding box of its corners, in the paper's normalized coordinates. */
export function mappedRect(map: SpotEvidence["map"], box: SpotBox): SpotBox {
  const corners = [
    applyAffine(map, box.x, box.y), applyAffine(map, box.x + box.w, box.y),
    applyAffine(map, box.x, box.y + box.h), applyAffine(map, box.x + box.w, box.y + box.h),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return clampBox({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
}

export function unionBox(boxes: SpotBox[]): SpotBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function padBox(b: SpotBox, mx: number, my: number): SpotBox {
  return clampBox({ x: b.x - mx, y: b.y - my, w: b.w + 2 * mx, h: b.h + 2 * my });
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
