import { BLANK_INK_THRESHOLD, dilate, INK_THRESHOLD, inkMask, type Mask } from "./image";
import type { Affine, GrayImage, SpotBox } from "./types";

// Added ink: what the student put on the page. A pixel counts when it is dark on the student's page (where the blank pixel
// lands after registration) and the blank has no ink near it (the blank's ink is dilated, so printed text that came out a
// little thicker or a pixel off on the scan is not counted). Isolated dark pixels (scanner specks) are ignored.

/** Pixels per inch every page is rendered at for mark detection. */
export const OMR_DPI = 150;
/** How far (blank pixels at OMR_DPI) the blank's printed ink is grown before comparing: absorbs scan blur and registration error. */
export const BLANK_COVER_RADIUS = 3;

/** The blank page as mark detection compares it: where printed ink is (grown by BLANK_COVER_RADIUS). */
export interface CoveredBlank {
  width: number;
  height: number;
  covered: Mask;
}

export function coverBlank(blank: GrayImage, radius = BLANK_COVER_RADIUS): CoveredBlank {
  return { width: blank.width, height: blank.height, covered: dilate(inkMask(blank, BLANK_INK_THRESHOLD), radius) };
}

export interface InkScore {
  /** Added-ink pixels in the box. */
  pixels: number;
  /** pixels / area. */
  fraction: number;
  /** The box's area in blank pixels. */
  area: number;
}

/**
 * The student's added ink inside `box` (blank normalized coordinates). `px` maps blank pixels to student pixels;
 * `studentInk` is the student's page as an ink mask (inkMask with INK_THRESHOLD).
 */
export function addedInk(blank: CoveredBlank, studentInk: Mask, px: Affine, box: SpotBox): InkScore {
  const x0 = clampInt(Math.floor(box.x * blank.width), 0, blank.width);
  const x1 = clampInt(Math.ceil((box.x + box.w) * blank.width), 0, blank.width);
  const y0 = clampInt(Math.floor(box.y * blank.height), 0, blank.height);
  const y1 = clampInt(Math.ceil((box.y + box.h) * blank.height), 0, blank.height);
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const { width: sw, height: sh, data: s } = studentInk;
  const cover = blank.covered.data;
  let pixels = 0;
  for (let y = y0; y < y1; y++) {
    // q = px · (x, y): start of the row, then step by (a, d) per pixel.
    let qx = px.a * x0 + px.b * y + px.c;
    let qy = px.d * x0 + px.e * y + px.f;
    const row = y * blank.width;
    for (let x = x0; x < x1; x++, qx += px.a, qy += px.d) {
      if (cover[row + x]) continue;
      const ix = Math.round(qx);
      const iy = Math.round(qy);
      if (ix < 1 || iy < 1 || ix >= sw - 1 || iy >= sh - 1) continue;
      const at = iy * sw + ix;
      if (!s[at]) continue;
      // At least two inked neighbours: a speck of scanner noise is not a mark.
      const neighbours = s[at - 1] + s[at + 1] + s[at - sw] + s[at + sw] + s[at - sw - 1] + s[at - sw + 1] + s[at + sw - 1] + s[at + sw + 1];
      if (neighbours >= 2) pixels++;
    }
  }
  return { pixels, fraction: pixels / area, area };
}

/** Strokes this close (blank pixels) are one mark: a circle drawn over the printed letter's grown ink is cut into arcs. */
const STROKE_BRIDGE = 3;
/** Room around the options (blank pixels) where a mark's strokes still join up. */
const MARK_ROOM = 8;

/**
 * The added ink of each option of one choice question (fractions of each option's box), with every mark counted for the
 * option it is drawn around: a stroke (a circle, tick or fill, with gaps up to STROKE_BRIDGE) belongs to the option box
 * holding its centre, so a big circle around "a." that dips into "b."'s box is all "a.". A stroke centred on no option,
 * or running through the middle of two or more options (a line, a scribble), is counted where its ink falls, as addedInk does.
 */
export function choiceInk(blank: CoveredBlank, studentInk: Mask, px: Affine, boxes: SpotBox[]): InkScore[] {
  if (boxes.length === 0) return [];
  const pixelBox = (b: SpotBox) => ({
    x0: clampInt(Math.floor(b.x * blank.width), 0, blank.width),
    x1: clampInt(Math.ceil((b.x + b.w) * blank.width), 0, blank.width),
    y0: clampInt(Math.floor(b.y * blank.height), 0, blank.height),
    y1: clampInt(Math.ceil((b.y + b.h) * blank.height), 0, blank.height),
  });
  const rects = boxes.map(pixelBox);
  const areas = rects.map((r) => Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0)));
  const centers = rects.map((r) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }));
  // Options whose middles are closer than half a box are in the same row (or column): a scan never lines them up exactly.
  const rowGap = Math.min(...rects.map((r) => r.y1 - r.y0)) / 2;
  const columnGap = Math.min(...rects.map((r) => r.x1 - r.x0)) / 2;
  // The region: every option, with room around them.
  const rx0 = clampInt(Math.min(...rects.map((r) => r.x0)) - MARK_ROOM, 0, blank.width);
  const rx1 = clampInt(Math.max(...rects.map((r) => r.x1)) + MARK_ROOM, 0, blank.width);
  const ry0 = clampInt(Math.min(...rects.map((r) => r.y0)) - MARK_ROOM, 0, blank.height);
  const ry1 = clampInt(Math.max(...rects.map((r) => r.y1)) + MARK_ROOM, 0, blank.height);
  const w = Math.max(0, rx1 - rx0);
  const h = Math.max(0, ry1 - ry0);
  const added = new Uint8Array(w * h);
  const { width: sw, height: sh, data: s } = studentInk;
  const cover = blank.covered.data;
  for (let y = ry0; y < ry1; y++) {
    let qx = px.a * rx0 + px.b * y + px.c;
    let qy = px.d * rx0 + px.e * y + px.f;
    const row = y * blank.width;
    for (let x = rx0; x < rx1; x++, qx += px.a, qy += px.d) {
      if (cover[row + x]) continue;
      const ix = Math.round(qx);
      const iy = Math.round(qy);
      if (ix < 1 || iy < 1 || ix >= sw - 1 || iy >= sh - 1) continue;
      const at = iy * sw + ix;
      if (!s[at]) continue;
      const neighbours = s[at - 1] + s[at + 1] + s[at - sw] + s[at + sw] + s[at - sw - 1] + s[at - sw + 1] + s[at + sw - 1] + s[at + sw + 1];
      if (neighbours >= 2) added[(y - ry0) * w + (x - rx0)] = 1;
    }
  }

  // Marks: connected parts of the added ink, bridged over small gaps.
  const bridged = dilate({ width: w, height: h, data: added }, STROKE_BRIDGE).data;
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const pixels = boxes.map(() => 0);
  const inBox = (x: number, y: number) => rects.findIndex((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  let marks = 0;
  for (let start = 0; start < w * h; start++) {
    if (!bridged[start] || label[start] !== -1) continue;
    const mark = marks++;
    let top = 0;
    stack[top++] = start;
    label[start] = mark;
    const perBox = boxes.map(() => 0);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    while (top > 0) {
      const at = stack[--top];
      const lx = at % w;
      const ly = (at - lx) / w;
      if (added[at]) {
        const x = lx + rx0;
        const y = ly + ry0;
        count++;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        const k = inBox(x, y);
        if (k >= 0) perBox[k]++;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = ly + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = lx + dx;
          if (nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (bridged[n] && label[n] === -1) {
            label[n] = mark;
            stack[top++] = n;
          }
        }
      }
    }
    if (count === 0) continue;
    // Through options: across the middle of two or more rows of options (a line down a column), or of two or more columns
    // (a line along a row). A circle around one option reaches the middle of no neighbour's row or column.
    const rows: number[] = [];
    const columns: number[] = [];
    rects.forEach((r, k) => {
      const c = centers[k];
      if (minX < r.x1 && maxX >= r.x0 && c.y >= minY && c.y <= maxY) rows.push(c.y);
      if (minY < r.y1 && maxY >= r.y0 && c.x >= minX && c.x <= maxX) columns.push(c.x);
    });
    const spansOptions = distinct(rows, rowGap) >= 2 || distinct(columns, columnGap) >= 2;
    const owner = spansOptions ? -1 : inBox(sumX / count, sumY / count);
    if (owner >= 0) pixels[owner] += perBox.reduce((a, b) => a + b, 0);
    else perBox.forEach((n, k) => { pixels[k] += n; });
  }
  return pixels.map((n, k) => ({ pixels: n, fraction: n / areas[k], area: areas[k] }));
}

/** How many groups `values` fall into, values closer than `gap` being one group. */
function distinct(values: number[], gap: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] >= gap).length;
}

/** The student's page as mark detection reads it. */
export function studentInkMask(student: GrayImage): Mask {
  return inkMask(student, INK_THRESHOLD);
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
