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

/** The student's page as mark detection reads it. */
export function studentInkMask(student: GrayImage): Mask {
  return inkMask(student, INK_THRESHOLD);
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
