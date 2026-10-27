import "server-only";
import { AiError } from "@/lib/ai/errors";
import type { AnswerSpots, DetectedSpot, SpotDetection } from "@/lib/ai/grader";
import { extractPageSets } from "@/lib/storage/pdf";
import { readChoice, readWriteIn } from "./decide";
import { TOP_STRIP } from "./identity-zones";
import type { Mask } from "./image";
import { addedInk, choiceInk, type CoveredBlank, coverBlank, OMR_DPI, studentInkMask } from "./ink";
import { grayToPng, openPdf } from "./pdf-raster";
import { applyAffine, type PreparedPage, prepareBlankPage, type Registration, registerPage } from "./register";
import { clampBox } from "./text-zones";
import {
  type GrayImage, type IdentityCrop, type IdentityKind, isIdentityKind, type QuestionSpots, type SpotBox, type SpotEvidence,
} from "./types";

// Mark detection on a paper (server side): render the blank and the paper's pages at OMR_DPI, line each paper page up with
// its blank page, measure the ink the student added in every answer spot, read choices and blanks from it, and crop written
// spots (at CROP_DPI) for the AI to transcribe. Pure image code apart from pdf.js rendering.

/** Written spots are cropped from the paper rendered at this density, for the AI to read. */
export const CROP_DPI = 200;
/** Margin around a spot's crop (inches): the start of a word written past the line, or a circle drawn wide. */
const CROP_MARGIN_IN = 0.15;
/** The page's aspect ratio may differ from the blank's by this much (a scan cropped a little, A4 vs Letter). */
export const MAX_ASPECT_CHANGE = 0.12;

export interface PreparedBlankPage {
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
export function answerSpots(o: {
  blankPdf: () => Promise<Uint8Array>; sha: string; plan: SpotPlanEntry[];
  /** The blank's identity spots (name, class); [] reads the top of page 1 for the name. Omitted: identity isn't read. */
  identity?: () => Promise<IdentitySpotsPlan>;
}): AnswerSpots {
  return {
    refs: o.plan.map((p) => p.ref),
    async read(pdf, pages, opts) {
      const worksheet = await prepareWorksheet(await o.blankPdf(), o.sha);
      const identity = o.identity ? await o.identity() : undefined;
      return readPaperSpots({ paperPdf: pdf, pages, worksheet, plan: o.plan, signal: opts.signal, identity });
    },
  };
}

const UNALIGNED = "Couldn't line up this paper with the blank worksheet, so the AI read every question.";

/** What was read on one page of a paper (lined up with its blank page). */
export interface PageSpots {
  /** The planned items on this blank page, in plan order, with their plan index. */
  items: Array<{ planIndex: number; detected: DetectedSpot }>;
  /** The identity spots on this blank page (or the top strip of page 1), when asked for. */
  identity: IdentityCrop[];
}

/**
 * The page's added ink in every planned spot on blank page `blankPage`, read as choices and blanks, and the crops of the
 * written ones (at CROP_DPI, one render of the page when it has any). `student` is the page rendered as wide as the blank,
 * `reg` its registration; `hiRes` renders the page at CROP_DPI. `identity`: the identity spots to read on this page
 * (`TOP_STRIP` on page 1 when the blank has none); omitted, nothing is read for identity.
 */
export async function readPageSpots(i: {
  worksheet: PreparedWorksheet; blankPage: number; reg: Registration; studentInk: Mask; plan: SpotPlanEntry[];
  hiRes: () => Promise<GrayImage>; identity?: IdentitySpotsPlan;
}): Promise<PageSpots> {
  const blank = i.worksheet.pages[i.blankPage - 1];
  const marginX = (CROP_MARGIN_IN * 72) / blank.widthPt;
  const marginY = (CROP_MARGIN_IN * 72) / blank.heightPt;
  const items: PageSpots["items"] = [];
  /** Written spots to crop: each with where its crop goes. */
  const crops: Array<{ box: SpotBox; put: (crop: NonNullable<DetectedSpot["crop"]>) => void }> = [];
  i.plan.forEach(({ ref, spot }, planIndex) => {
    if (spot.page !== i.blankPage) return;
    const crop = padBox(unionBox(spot.kind === "choice" ? spot.options.map((o) => o.box) : spot.boxes), marginX, marginY);
    const evidence: SpotEvidence = { kind: spot.kind, page: spot.page, crop, map: i.reg.map };
    if (spot.kind === "choice") {
      const inks = choiceInk(blank.covered, i.studentInk, i.reg.px, spot.options.map((o) => o.box));
      const options = spot.options.map((o, k) => ({ value: o.value, box: o.box, ink: inks[k].fraction }));
      items.push({
        planIndex,
        detected: {
          ref, kind: "choice", values: spot.options.map((o) => o.value), multi: spot.multi,
          evidence: { ...evidence, options: options.map((o) => ({ ...o, ink: round4(o.ink) })) },
          choice: readChoice(options),
        },
      });
      return;
    }
    const { pixels, fraction } = inkIn(blank.covered, i.studentInk, i.reg.px, spot.boxes);
    const written = readWriteIn(pixels, fraction);
    const detected: DetectedSpot = {
      ref, kind: spot.kind, values: [], multi: false, evidence: { ...evidence, boxes: spot.boxes, ink: round4(fraction) }, written,
    };
    items.push({ planIndex, detected });
    if (written.written) crops.push({ box: crop, put: (c) => { detected.crop = c; } });
  });

  const identity: IdentityCrop[] = [];
  for (const spot of identityOnPage(i.identity, i.blankPage)) {
    const { pixels, fraction } = inkIn(blank.covered, i.studentInk, i.reg.px, spot.boxes);
    const written = readWriteIn(pixels, fraction);
    const entry: IdentityCrop = { kind: spot.kind, label: spot.label, written: written.written, confidence: written.confidence };
    identity.push(entry);
    if (written.written) {
      crops.push({ box: padBox(unionBox(spot.boxes), marginX, marginY), put: (c) => { entry.crop = c; } });
    }
  }

  // Written spots: crops at CROP_DPI, from one render of the page.
  if (crops.length > 0) {
    const hi = await i.hiRes();
    for (const c of crops) {
      const img = cropMapped(hi, i.reg.map, c.box);
      c.put({ png: await grayToPng(img), width: img.width, height: img.height });
    }
  }
  return { items, identity };
}

/** Identity spots to read: the blank's (kind "name" or "section"), or [] for the top strip of page 1. */
export type IdentitySpotsPlan = Array<Pick<QuestionSpots, "kind" | "label" | "page" | "boxes">>;


function identityOnPage(plan: IdentitySpotsPlan | undefined, page: number): Array<{ kind: IdentityKind; label: string; boxes: SpotBox[] }> {
  if (plan === undefined) return [];
  const usable = plan.filter((s) => isIdentityKind(s.kind) && s.boxes.length > 0);
  if (!usable.some((s) => s.kind === "name")) {
    // No name spot: the top of page 1, where names are written (any section spot is read too).
    const strip = page === 1 ? [{ kind: "name" as const, label: "Top of page 1", boxes: [TOP_STRIP] }] : [];
    return [...strip, ...usable.filter((s) => s.page === page).map((s) => ({ kind: s.kind as IdentityKind, label: s.label, boxes: s.boxes }))];
  }
  return usable.filter((s) => s.page === page).map((s) => ({ kind: s.kind as IdentityKind, label: s.label, boxes: s.boxes }));
}

/** The blank pages the identity spots are on (page 1 for the top strip). */
export function identityPages(plan: IdentitySpotsPlan | undefined): number[] {
  if (plan === undefined) return [];
  const usable = plan.filter((s) => isIdentityKind(s.kind) && s.boxes.length > 0);
  const pages = usable.map((s) => s.page);
  if (!usable.some((s) => s.kind === "name")) pages.push(1);
  return [...new Set(pages)];
}

function inkIn(covered: CoveredBlank, studentInk: Mask, px: Registration["px"], boxes: SpotBox[]): { pixels: number; fraction: number } {
  let pixels = 0;
  let area = 0;
  for (const box of boxes) {
    const score = addedInk(covered, studentInk, px, box);
    pixels += score.pixels;
    area += score.area;
  }
  return { pixels, fraction: area > 0 ? pixels / area : 0 };
}

/** Reads every planned spot on the paper (its `pages` within `paperPdf`, in order), and its identity spots when asked. */
export async function readPaperSpots(i: {
  paperPdf: Uint8Array; pages: number[]; worksheet: PreparedWorksheet; plan: SpotPlanEntry[]; signal?: AbortSignal;
  identity?: IdentitySpotsPlan;
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
    const needed = [...new Set([...i.plan.map((p) => p.spot.page), ...identityPages(i.identity)])]
      .filter((page) => page >= 1 && page <= worksheet.pages.length)
      .sort((a, b) => a - b);
    const lined = new Map<number, { reg: Registration; ink: Mask }>();
    for (const page of needed) {
      if (i.signal?.aborted) throw new AiError("aborted", "Stopped while reading the answer spots.", { retryable: true });
      const blank = worksheet.pages[page - 1];
      const size = await doc.pageSize(i.pages[page - 1]);
      if (aspectChange(size, blank) > MAX_ASPECT_CHANGE) return { ok: false, reason: "unaligned", note: UNALIGNED };
      // Rendered as wide as the blank, so registration only has to find small changes of scale.
      const student = await doc.renderGray(i.pages[page - 1], { widthPx: blank.gray.width });
      const reg = registerPage(blank.prepared, student);
      if (!reg.ok) return { ok: false, reason: "unaligned", note: UNALIGNED };
      lined.set(page, { reg, ink: studentInkMask(student) });
    }

    const read: PageSpots["items"] = [];
    const identity: IdentityCrop[] = [];
    for (const page of needed) {
      const at = lined.get(page)!;
      const blank = worksheet.pages[page - 1];
      const result = await readPageSpots({
        worksheet, blankPage: page, reg: at.reg, studentInk: at.ink, plan: i.plan, identity: i.identity,
        hiRes: () => doc.renderGray(i.pages[page - 1], { widthPx: Math.round((blank.widthPt / 72) * CROP_DPI) }),
      });
      read.push(...result.items);
      identity.push(...result.identity);
    }
    const items = read.sort((a, b) => a.planIndex - b.planIndex).map((x) => x.detected);
    const [identityPdf] = await extractPageSets(i.paperPdf, [[i.pages[0]]]);
    return { ok: true, items, identityPdf, ...(i.identity === undefined ? {} : { identity }) };
  } finally {
    await doc.close();
  }
}

/** How much a page's shape differs from the blank's (0: the same aspect ratio). */
export function aspectChange(size: { width: number; height: number }, blank: { widthPt: number; heightPt: number }): number {
  return Math.abs(size.height / size.width - blank.heightPt / blank.widthPt) / (blank.heightPt / blank.widthPt);
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
