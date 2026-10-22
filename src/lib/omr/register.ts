import { BLANK_INK_THRESHOLD, dilate, INK_THRESHOLD, inkMask, inkPoints, type Mask, orDownscale } from "./image";
import type { Affine, GrayImage } from "./types";

// Lining a student's page up with the blank worksheet page ("registration"). Scanners and phones shift, scale and rotate
// pages a little; the answer spots are on the blank, so each one must be found on the student's page first.
//
// The model: a blank pixel p maps to the student pixel q = s·R(θ)·(p − blank centre) + student centre + t (uniform scale s,
// rotation θ within ±5° — or about 180° for a page scanned upside down — and translation t). It is found coarse to fine,
// maximizing the share of the blank's ink that lands on ink of the student's page (the student's own marks only add ink,
// so they do not pull the fit): an exhaustive search on 1/8-size ink maps, then local refinements at 1/4, 1/2 and full size.
// Everything is integer lookups in typed arrays; a page takes well under a second.

export interface Registration {
  /** The share of the blank's ink found on the student's page at full size (1 = perfect). */
  score: number;
  /** score ≥ REGISTRATION_MIN_SCORE: the pages line up. */
  ok: boolean;
  /** Blank pixel → student pixel. */
  px: Affine;
  /** Blank normalized page coordinates → student normalized page coordinates. */
  map: Affine;
  angleDeg: number;
  scale: number;
}

/** Below this, the student's page is not taken to be the blank worksheet's page (another worksheet, a blank page…). */
export const REGISTRATION_MIN_SCORE = 0.6;

/** The blank's ink pyramid, computed once per blank page and reused for every paper. */
export interface PreparedPage {
  width: number;
  height: number;
  /** Per level (factor 8, 4, 2, 1): sampled ink points of the blank (x, y interleaved, level pixels) and the level's size. */
  levels: Array<{ f: number; width: number; height: number; points: Float64Array }>;
  inkCount: number;
}

const LEVELS = [8, 4, 2, 1] as const;
const POINTS_PER_LEVEL: Record<number, number> = { 8: 300, 4: 1000, 2: 2000, 1: 3000 };

export function prepareBlankPage(blank: GrayImage): PreparedPage {
  const ink = inkMask(blank, BLANK_INK_THRESHOLD);
  let inkCount = 0;
  for (let i = 0; i < ink.data.length; i++) inkCount += ink.data[i];
  return {
    width: blank.width,
    height: blank.height,
    inkCount,
    levels: LEVELS.map((f) => {
      const level = orDownscale(ink, f);
      return { f, width: level.width, height: level.height, points: inkPoints(level, POINTS_PER_LEVEL[f]) };
    }),
  };
}

interface Params {
  theta: number;
  scale: number;
  tx: number;
  ty: number;
}

interface Scored extends Params {
  score: number;
}

/** Registers `student` to the prepared blank page. Both are rendered at the same pixel density. */
export function registerPage(blank: PreparedPage, student: GrayImage): Registration {
  const studentInk = inkMask(student, INK_THRESHOLD);
  if (blank.inkCount < 50) return result(blank, student, { theta: 0, scale: 1, tx: 0, ty: 0, score: 0 });
  const targets = new Map<number, Mask>();
  // The coarse map is already forgiving (each pixel is an 8×8 block); finer maps allow a pixel of slack.
  for (const f of LEVELS) targets.set(f, f === 8 ? orDownscale(studentInk, f) : dilate(orDownscale(studentInk, f), 1));

  // Coarse: every rotation, scale and shift on the 1/8 maps; the best few go on.
  const coarse = searchCoarse(blank, targets.get(8)!, student, 0);
  let candidates = coarse;
  if (coarse[0].score < 0.5) {
    // Maybe upside down.
    candidates = [...coarse, ...searchCoarse(blank, targets.get(8)!, student, Math.PI)].sort((a, b) => b.score - a.score).slice(0, KEEP);
  }
  // Each candidate is refined at 1/4 size; the best one goes on to 1/2 and full size.
  let best: Scored | null = null;
  for (const start of candidates) {
    const p = refine(blank, targets.get(4)!, student, 4, { ...start, tx: start.tx * 2, ty: start.ty * 2 });
    if (!best || p.score > best.score) best = p;
  }
  const half = refine(blank, targets.get(2)!, student, 2, { ...best!, tx: best!.tx * 2, ty: best!.ty * 2 });
  const full = refine(blank, targets.get(1)!, student, 1, { ...half, tx: half.tx * 2, ty: half.ty * 2 });
  return result(blank, student, full);
}

function result(blank: PreparedPage, student: GrayImage, p: Scored): Registration {
  const px = pixelAffine(blank, student, p, 1);
  return {
    score: p.score,
    ok: p.score >= REGISTRATION_MIN_SCORE,
    px,
    map: {
      a: (px.a * blank.width) / student.width,
      b: (px.b * blank.height) / student.width,
      c: px.c / student.width,
      d: (px.d * blank.width) / student.height,
      e: (px.e * blank.height) / student.height,
      f: px.f / student.height,
    },
    angleDeg: (p.theta * 180) / Math.PI,
    scale: p.scale,
  };
}

/** Blank pixel → student pixel at level factor f (shifts are in level pixels). */
function pixelAffine(blank: PreparedPage, student: GrayImage, p: Params, f: number): Affine {
  const cos = p.scale * Math.cos(p.theta);
  const sin = p.scale * Math.sin(p.theta);
  const cbx = blank.width / f / 2;
  const cby = blank.height / f / 2;
  const csx = student.width / f / 2;
  const csy = student.height / f / 2;
  return {
    a: cos, b: -sin, c: -cos * cbx + sin * cby + csx + p.tx,
    d: sin, e: cos, f: -sin * cbx - cos * cby + csy + p.ty,
  };
}

/** The share of the blank's sampled ink points (at level f) that land on the student's ink under `p`. */
function scoreAt(points: Float64Array, target: Mask, m: Affine): number {
  let hits = 0;
  const n = points.length / 2;
  const { width, height, data } = target;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const qx = Math.round(m.a * x + m.b * y + m.c);
    const qy = Math.round(m.d * x + m.e * y + m.f);
    if (qx >= 0 && qy >= 0 && qx < width && qy < height) hits += data[qy * width + qx];
  }
  return n === 0 ? 0 : hits / n;
}

const DEG = Math.PI / 180;

// The refinements reach about ±2.5° and ±4% around each coarse candidate, so a coarse grid this sparse covers ±5° and ±8%.
const COARSE_DEGREES = [-4, -2, 0, 2, 4];
const COARSE_SCALES = [0.95, 1, 1.05];

/** Coarse candidates refined further. */
const KEEP = 4;

/** A small penalty that only decides between near-equal fits: prefer the simpler transform. */
function prior(deg: number, scale: number, shiftX: number, shiftY: number): number {
  return 0.002 * Math.abs(deg) + 0.05 * Math.abs(scale - 1) + 0.02 * (Math.abs(shiftX) + Math.abs(shiftY));
}

function searchCoarse(blank: PreparedPage, target: Mask, student: GrayImage, baseTheta: number): Scored[] {
  const level = blank.levels[0];
  const f = level.f;
  const maxShiftX = Math.ceil(target.width * 0.12);
  const maxShiftY = Math.ceil(target.height * 0.12);
  // The target with a margin as wide as the largest shift, so the inner loop needs no bounds checks.
  const pw = target.width + 2 * maxShiftX;
  const ph = target.height + 2 * maxShiftY;
  const padded = new Uint8Array(pw * ph);
  for (let y = 0; y < target.height; y++) padded.set(target.data.subarray(y * target.width, (y + 1) * target.width), (y + maxShiftY) * pw + maxShiftX);
  const best: Scored[] = [];
  const points = level.points;
  const n = points.length / 2;
  const base = new Int32Array(n);
  for (const deg of COARSE_DEGREES) {
    for (const scale of COARSE_SCALES) {
      const theta = baseTheta + deg * DEG;
      const m = pixelAffine(blank, student, { theta, scale, tx: 0, ty: 0 }, f);
      // Each point's index in the padded target at shift (0, 0); points that fall off the page entirely never hit.
      let count = 0;
      for (let i = 0; i < n; i++) {
        const x = Math.round(m.a * points[2 * i] + m.b * points[2 * i + 1] + m.c);
        const y = Math.round(m.d * points[2 * i] + m.e * points[2 * i + 1] + m.f);
        if (x < -maxShiftX || y < -maxShiftY || x >= target.width + maxShiftX || y >= target.height + maxShiftY) continue;
        base[count++] = (y + maxShiftY) * pw + x + maxShiftX;
      }
      for (let ty = -maxShiftY; ty <= maxShiftY; ty++) {
        for (let tx = -maxShiftX; tx <= maxShiftX; tx++) {
          const shift = ty * pw + tx;
          const lo = -shift;
          const hi = pw * ph - shift;
          let hits = 0;
          for (let i = 0; i < count; i++) {
            const at = base[i];
            if (at >= lo && at < hi) hits += padded[at + shift];
          }
          // Ties (repeated lines, ruled paper) go to the smaller rotation, scale change and shift.
          const score = (n === 0 ? 0 : hits / n) - prior(deg, scale, tx / target.width, ty / target.height);
          if (best.length < KEEP || score > best[best.length - 1].score) {
            // Keep the best few that are not near-duplicates of one another.
            const near = best.findIndex((b) => Math.abs(b.tx - tx) <= 2 && Math.abs(b.ty - ty) <= 2 && Math.abs(b.theta - theta) <= 2 * DEG);
            if (near !== -1) {
              if (best[near].score < score) best[near] = { theta, scale, tx, ty, score };
            } else {
              best.push({ theta, scale, tx, ty, score });
            }
            best.sort((a, b) => b.score - a.score);
            if (best.length > KEEP) best.length = KEEP;
          }
        }
      }
    }
  }
  return best;
}

/** A local search around `p` at level f: rotation, scale, then shift, until nothing improves. */
function refine(blank: PreparedPage, target: Mask, student: GrayImage, f: number, p: Params): Scored {
  const level = blank.levels.find((l) => l.f === f)!;
  const dTheta = (f >= 4 ? 0.4 : f === 2 ? 0.15 : 0.05) * DEG;
  const dScale = f >= 4 ? 0.008 : f === 2 ? 0.003 : 0.0012;
  const span = 2;
  const evaluate = (q: Params) => scoreAt(level.points, target, pixelAffine(blank, student, q, f));
  let best: Scored = { ...p, score: evaluate(p) };
  for (let round = 0; round < 6; round++) {
    let improved = false;
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const q = { ...best, theta: best.theta + i * dTheta, scale: best.scale + j * dScale };
        for (let ty = -2; ty <= 2; ty++) {
          for (let tx = -2; tx <= 2; tx++) {
            const cand = { ...q, tx: Math.round(best.tx) + tx, ty: Math.round(best.ty) + ty };
            const score = evaluate(cand);
            if (score > best.score + 1e-9) {
              best = { ...cand, score };
              improved = true;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

/** Applies a normalized affine map to a point. */
export function applyAffine(m: Affine, u: number, v: number): [number, number] {
  return [m.a * u + m.b * v + m.c, m.d * u + m.e * v + m.f];
}

/** The identity map (a page that needs no lining up). */
export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };
