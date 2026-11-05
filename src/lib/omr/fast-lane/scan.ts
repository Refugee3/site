import "server-only";
import { AiError } from "@/lib/ai/errors";
import {
  aspectChange, CROP_DPI, type IdentitySpotsPlan, MAX_ASPECT_CHANGE, type PageSpots, pagesWithCrops, type PreparedWorksheet, readPageSpots,
  renderForMarks, type SpotPlanEntry,
} from "../detect";
import { studentInkMask } from "../ink";
import { openPdf } from "../pdf-raster";
import { REGISTRATION_MIN_SCORE } from "../register";
import { readAhead, renderThreads } from "../render-pool";
import { isIdentityKind, type SpotBox } from "../types";
import type { MatchedPage } from "./group";
import { BLANK_PAGE_INK, MATCH_CONFIDENT, type MatchBlank, matchPage, prepareMatchBlank } from "./match";

// The fast lane's pass over a whole-class scan (server side): each page is rendered once at mark-detection density,
// matched to a page of the blank worksheet (match.ts), and, when it lines up well, its answer spots and name spots are
// read at once (ink, choices, and the crops of what is written). Nothing here calls the AI. The next pages render (in worker
// threads) while one is matched and read.

export interface AnalyzedPage extends MatchedPage {
  /** The match score (0..1). */
  score: number;
  /** Lined up well enough for its marks to be read; a page matched less surely is read by the AI with its paper. */
  readable: boolean;
  /** What was read on it (readable pages only). */
  spots: PageSpots | null;
  /** Rendering and matching the page, and reading its spots (ms). */
  matchMs: number;
  readMs: number;
  /** Blank pages lined up to match it. */
  tried: number;
}

const prepared = new WeakMap<PreparedWorksheet, MatchBlank[]>();

/** The blank's pages prepared for matching, with each page's answer and name areas (kept with the prepared worksheet). */
function matchBlanks(worksheet: PreparedWorksheet, plan: SpotPlanEntry[], identity: IdentitySpotsPlan): MatchBlank[] {
  const hit = prepared.get(worksheet);
  if (hit) return hit;
  const blanks = worksheet.pages.map((page, i) => {
    const areas: SpotBox[] = [
      ...plan.filter((p) => p.spot.page === i + 1).flatMap((p) => (p.spot.kind === "choice" ? p.spot.options.map((o) => o.box) : p.spot.boxes)),
      ...identity.filter((s) => s.page === i + 1 && isIdentityKind(s.kind)).flatMap((s) => s.boxes),
    ];
    return prepareMatchBlank(page.gray, { prepared: page.prepared, covered: page.covered.covered }, areas);
  });
  prepared.set(worksheet, blanks);
  return blanks;
}

/** Matches and reads every page of the scan, in order. `onPage` is told after each page (to report progress). */
export async function analyzeScan(i: {
  scanPdf: Uint8Array; worksheet: PreparedWorksheet; plan: SpotPlanEntry[]; identity: IdentitySpotsPlan; signal?: AbortSignal;
  onPage?: (done: number, total: number) => void;
}): Promise<AnalyzedPage[]> {
  const { worksheet } = i;
  const k = worksheet.pages.length;
  const blanks = matchBlanks(worksheet, i.plan, i.identity);
  const first = worksheet.pages[0];
  const doc = await openPdf(i.scanPdf);
  try {
    const out: AnalyzedPage[] = [];
    // Every blank page has the name or a written spot: each matched page will need crops.
    const withCrops = pagesWithCrops(i.plan, i.identity);
    const cropsLikely = worksheet.pages.every((_, k) => withCrops.has(k + 1));
    // One render when crops are likely on any page (a 1-page quiz: always, for the name), shrunk for matching; none for a
    // page of another shape.
    const rendered = readAhead(doc.numPages, renderThreads(), async (page) => {
      const started = performance.now();
      const size = await doc.pageSize(page);
      const render = aspectChange(size, first) > MAX_ASPECT_CHANGE ? null : await renderForMarks(doc, page, first, cropsLikely);
      return { render, ms: performance.now() - started };
    });
    let previous: number | null = null;
    for (let page = 1; page <= doc.numPages; page++) {
      if (i.signal?.aborted) throw new AiError("aborted", "Stopped while matching the scan's pages.", { retryable: true });
      const { render, ms } = await rendered(page);
      // The page's own rendering time (it may have rendered ahead), plus matching from here.
      const started = performance.now() - ms;
      const unmatched = (o: Partial<AnalyzedPage> = {}): AnalyzedPage => ({
        page, blankPage: null, ambiguous: false, blank: false, nameInk: null, score: 0, readable: false, spots: null,
        matchMs: Math.round(performance.now() - started), readMs: 0, tried: 0, ...o,
      });
      if (render === null) {
        out.push(unmatched());
        i.onPage?.(page, doc.numPages);
        continue;
      }
      const { gray, hiRes } = render;
      // The page after worksheet page j is most likely page j + 1, or the next paper's page 1.
      const expected = previous === null || previous >= k ? 1 : previous + 1;
      const m = matchPage(blanks, gray, expected);
      const matchMs = Math.round(performance.now() - started);
      if (m.blankPage === null || m.reg === null) {
        out.push(unmatched({ blank: m.tried === 0 && m.ink < BLANK_PAGE_INK, score: m.score, matchMs, tried: m.tried }));
        i.onPage?.(page, doc.numPages);
        continue;
      }
      previous = m.blankPage;
      const readable = m.score >= MATCH_CONFIDENT && m.reg.score >= REGISTRATION_MIN_SCORE;
      let spots: PageSpots | null = null;
      const readStarted = performance.now();
      if (readable) {
        const blank = worksheet.pages[m.blankPage - 1];
        const crops = blank.widthPt === first.widthPt
          ? hiRes
          : () => doc.renderGray(page, { widthPx: Math.round((blank.widthPt / 72) * CROP_DPI) });
        spots = await readPageSpots({
          worksheet, blankPage: m.blankPage, reg: m.reg, studentInk: studentInkMask(gray), plan: i.plan, identity: i.identity,
          hiRes: crops,
        });
      }
      const name = spots?.identity.find((c) => c.kind === "name");
      out.push({
        page, blankPage: m.blankPage, ambiguous: m.ambiguous, blank: false,
        nameInk: m.blankPage === 1 && name ? name.written : null,
        score: m.score, readable, spots, matchMs, readMs: Math.round(performance.now() - readStarted), tried: m.tried,
      });
      i.onPage?.(page, doc.numPages);
    }
    return out;
  } finally {
    await doc.close();
  }
}
