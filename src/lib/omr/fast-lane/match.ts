import { BLANK_INK_THRESHOLD, countInk, dilate, downscaleGray, INK_THRESHOLD, inkMask, inkPoints, type Mask } from "../image";
import { prepareBlankPage, type PreparedPage, type Registration, registerPage } from "../register";
import type { Affine, GrayImage, SpotBox } from "../types";

// Which page of the blank worksheet a scanned page is (pure image code, the fast lane's split). A scanned page is lined up
// with a blank page (register.ts) and given two scores:
// - forward: the share of the blank page's print found on the scanned page (registration's own score);
// - reverse: the share of the scanned page's ink that falls on the blank page's print, leaving out the ink in the blank's
//   answer and name areas (the student's handwriting) and near the page's edges (scanner borders, punched holes). Another
//   page's print lowers it a lot. Without it a sparse blank page (a title and an empty box) "matches" any page, since its
//   few lines land on some print everywhere.
// The match score is the lower of the two. The page the sequence predicts is tried first, at full density: a confident
// match ends the search there (most pages of a stack in order). Otherwise every other blank page is tried at half density
// (a quarter of the pixels), and the best one is confirmed at full density from the fit found at half density.

/** Pages are ranked at 1/MATCH_DOWNSCALE of the mark-detection density (OMR_DPI). */
export const MATCH_DOWNSCALE = 2;
/** A page matches a blank page at this score or above. */
export const MATCH_MIN_SCORE = 0.55;
/** At this score the predicted page is taken without trying the others; also the score a page must reach to be read. */
export const MATCH_CONFIDENT = 0.8;
/** The best page must beat the second by this much, or the match is ambiguous. */
export const MATCH_MARGIN = 0.12;
/** A page with less ink than this share of its pixels is blank. */
export const BLANK_PAGE_INK = 0.0015;
/** Ink this close to the page's edges (share of its size) is never compared: scanner borders, holes, staples. */
const EDGE = 0.03;
const REVERSE_POINTS = 3000;

/** The blank's print and answer areas at one density. */
interface Level {
  prepared: PreparedPage;
  /** The blank's print, grown a little: what the scanned page's ink is checked against. */
  covered: Mask;
  /** Where students write on this page (answer and name areas): ink there is not compared with the print. */
  answers: Mask;
}

/** One blank page prepared for matching. */
export interface MatchBlank {
  full: Level;
  half: Level;
}

/**
 * `full`: the blank page's registration pyramid and grown print at mark-detection density (as prepared for reading);
 * `answerAreas`: the page's answer and identity spot boxes (normalized blank coordinates).
 */
export function prepareMatchBlank(
  blankGray: GrayImage, full: { prepared: PreparedPage; covered: Mask }, answerAreas: SpotBox[] = [],
): MatchBlank {
  const half = downscaleGray(blankGray, MATCH_DOWNSCALE);
  return {
    full: { ...full, answers: answerMask(blankGray.width, blankGray.height, answerAreas) },
    half: {
      prepared: prepareBlankPage(half),
      covered: dilate(inkMask(half, BLANK_INK_THRESHOLD), 2),
      answers: answerMask(half.width, half.height, answerAreas),
    },
  };
}

function answerMask(width: number, height: number, areas: SpotBox[]): Mask {
  const data = new Uint8Array(width * height);
  // Handwriting runs on to the right of an area (a long answer past its line), and a little above and below it.
  for (const b of areas) {
    const x0 = Math.max(0, Math.floor((b.x - 0.02) * width));
    const y0 = Math.max(0, Math.floor((b.y - 0.004) * height));
    const y1 = Math.min(height, Math.ceil((b.y + b.h + 0.004) * height));
    for (let y = y0; y < y1; y++) data.fill(1, y * width + x0, (y + 1) * width);
  }
  return { width, height, data };
}

export interface PageMatch {
  /** 1-based blank page, or null: matches no page (a blank back, a cover page, another worksheet). */
  blankPage: number | null;
  /** The best page's score (full density). */
  score: number;
  /** The next best page's score (0 when the predicted page was taken at once). */
  second: number;
  /** The best and second best are too close to tell apart. */
  ambiguous: boolean;
  /** The share of the page's pixels that are ink: a blank page has almost none. */
  ink: number;
  /** The best page's registration at full density (null without a match): its marks are read with it. */
  reg: Registration | null;
  /** How many blank pages were lined up (at either density): the cost of the match. */
  tried: number;
}

/**
 * Matches one scanned page (rendered at the blank's width, at mark-detection density) to the blank pages, trying the
 * `expected` page (1-based) first.
 */
export function matchPage(blanks: MatchBlank[], student: GrayImage, expected: number | null = null): PageMatch {
  const fullInk = inkMask(student, INK_THRESHOLD);
  const inkShare = countInk(fullInk) / Math.max(1, fullInk.data.length);
  const none = (o: Partial<PageMatch> = {}): PageMatch => ({
    blankPage: null, score: 0, second: 0, ambiguous: false, ink: inkShare, reg: null, tried: 0, ...o,
  });
  if (inkShare < BLANK_PAGE_INK || blanks.length === 0) return none();
  const fullPoints = inkPoints(fullInk, REVERSE_POINTS);
  const scoreAt = (level: Level, img: GrayImage, points: Float64Array, start?: Registration) => {
    const reg = registerPage(level.prepared, img, start ? { start: scaledStart(start, MATCH_DOWNSCALE) } : {});
    return { reg, score: Math.min(reg.score, reverseCoverage(points, level, reg.px, img)) };
  };

  // The predicted page first, at full density.
  const predicted = expected !== null && expected >= 1 && expected <= blanks.length ? expected : null;
  let tried = 0;
  const candidates: Array<{ page: number; score: number; reg: Registration }> = [];
  if (predicted !== null) {
    const first = { page: predicted, ...scoreAt(blanks[predicted - 1].full, student, fullPoints) };
    tried++;
    if (first.score >= MATCH_CONFIDENT) {
      return { blankPage: predicted, score: first.score, second: 0, ambiguous: false, ink: inkShare, reg: first.reg, tried };
    }
    candidates.push(first);
  }

  // The others ranked at half density, the best confirmed at full density.
  const half = downscaleGray(student, MATCH_DOWNSCALE);
  const halfPoints = inkPoints(inkMask(half, INK_THRESHOLD), REVERSE_POINTS);
  const ranked: Array<{ page: number; score: number; reg: Registration }> = [];
  blanks.forEach((blank, i) => {
    if (i + 1 === predicted) return;
    tried++;
    ranked.push({ page: i + 1, ...scoreAt(blank.half, half, halfPoints) });
  });
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (top && top.score >= MATCH_MIN_SCORE * 0.8) {
    tried++;
    let confirmed = { page: top.page, ...scoreAt(blanks[top.page - 1].full, student, fullPoints, top.reg) };
    if (confirmed.score < MATCH_CONFIDENT) {
      // The half-density fit can be off on a sparse page: a full search at full density.
      tried++;
      const again = { page: top.page, ...scoreAt(blanks[top.page - 1].full, student, fullPoints) };
      if (again.score > confirmed.score) confirmed = again;
    }
    candidates.push(confirmed);
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  // The runner-up: the other full-density candidate, else the half-density ranking's next page.
  const second = Math.max(0, candidates[1]?.score ?? 0, ...ranked.filter((r) => r.page !== best?.page).map((r) => r.score));
  if (!best || best.score < MATCH_MIN_SCORE) return none({ score: best?.score ?? 0, second, tried });
  return {
    blankPage: best.page, score: best.score, second, ambiguous: best.score - second < MATCH_MARGIN, ink: inkShare, reg: best.reg, tried,
  };
}

/**
 * The share of the student's ink points (x, y interleaved, pixels of `img`) that land on the blank's grown print, through
 * `px`'s inverse; points in the blank's answer areas and near the page's edges are left out.
 */
export function reverseCoverage(
  points: Float64Array, blank: Pick<Level, "covered" | "answers">, px: Affine, img: { width: number; height: number },
): number {
  const det = px.a * px.e - px.b * px.d;
  if (points.length === 0 || Math.abs(det) < 1e-9) return 0;
  // Student pixel q → blank pixel p = A⁻¹·(q − c).
  const ia = px.e / det;
  const ib = -px.b / det;
  const id = -px.d / det;
  const ie = px.a / det;
  const { width, height, data } = blank.covered;
  const answers = blank.answers.data;
  const mx = img.width * EDGE;
  const my = img.height * EDGE;
  let hits = 0;
  let counted = 0;
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < mx || points[i] > img.width - mx || points[i + 1] < my || points[i + 1] > img.height - my) continue;
    const qx = points[i] - px.c;
    const qy = points[i + 1] - px.f;
    const x = Math.round(ia * qx + ib * qy);
    const y = Math.round(id * qx + ie * qy);
    const inside = x >= 0 && y >= 0 && x < width && y < height;
    if (inside && answers[y * width + x]) continue;
    counted++;
    if (inside) hits += data[y * width + x];
  }
  return counted === 0 ? 0 : hits / counted;
}

/** A registration found at 1/f density as a start at full density (its shift scaled up). */
function scaledStart(reg: Registration, f: number) {
  return { angleDeg: reg.angleDeg, scale: reg.scale, shiftX: reg.shiftX * f, shiftY: reg.shiftY * f };
}
