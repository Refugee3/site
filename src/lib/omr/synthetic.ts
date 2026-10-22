import { grayImage } from "./image";
import type { GrayImage } from "./types";

// Synthetic raster pages for the pure image tests: printed "glyphs" as filled rectangles, pen marks as rings, discs, lines
// and dots, and a scanner-like warp (shift, scale, rotation). No PDF involved.

export function blankPage(width = 1275, height = 1650): GrayImage {
  return grayImage(width, height);
}

/** A dark filled rectangle (pixels). */
export function fillRect(img: GrayImage, x: number, y: number, w: number, h: number, gray = 20): void {
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(img.height, Math.ceil(y + h)); yy++) {
    for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(img.width, Math.ceil(x + w)); xx++) img.data[yy * img.width + xx] = gray;
  }
}

/** A ring (a pen circle) of radius r and stroke width `stroke`. */
export function ring(img: GrayImage, cx: number, cy: number, r: number, stroke = 2.5, gray = 40): void {
  for (let y = Math.floor(cy - r - stroke); y <= Math.ceil(cy + r + stroke); y++) {
    for (let x = Math.floor(cx - r - stroke); x <= Math.ceil(cx + r + stroke); x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - r) <= stroke / 2) img.data[y * img.width + x] = gray;
    }
  }
}

export function disc(img: GrayImage, cx: number, cy: number, r: number, gray = 40): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (Math.hypot(x - cx, y - cy) <= r) img.data[y * img.width + x] = gray;
    }
  }
}

/** A straight stroke from (x0, y0) to (x1, y1). */
export function stroke(img: GrayImage, x0: number, y0: number, x1: number, y1: number, width = 2.5, gray = 40): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len * 2));
  for (let i = 0; i <= steps; i++) disc(img, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, width / 2, gray);
}

/** Some printed "text": a row of glyph-sized blocks with gaps, like a line of a worksheet. */
export function textLine(img: GrayImage, x: number, y: number, chars: number, charW = 9, charH = 14): void {
  for (let i = 0; i < chars; i++) if (i % 6 !== 5) fillRect(img, x + i * (charW + 3), y, charW, charH);
}

/**
 * The page as a scanner might return it: rotated by `angleDeg` about the centre, scaled by `scale`, shifted by (dx, dy)
 * pixels, onto a page of the same size (bilinear sampling, white outside).
 */
export function warp(img: GrayImage, o: { angleDeg?: number; scale?: number; dx?: number; dy?: number }): GrayImage {
  const theta = ((o.angleDeg ?? 0) * Math.PI) / 180;
  const s = o.scale ?? 1;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = img.width / 2;
  const cy = img.height / 2;
  const out = grayImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      // Inverse map: output (x, y) = s·R·(p − c) + c + d  →  p = Rᵀ·((x, y) − c − d)/s + c.
      const ux = (x - cx - (o.dx ?? 0)) / s;
      const uy = (y - cy - (o.dy ?? 0)) / s;
      const px = cos * ux + sin * uy + cx;
      const py = -sin * ux + cos * uy + cy;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) continue;
      const fx = px - x0;
      const fy = py - y0;
      const i = y0 * img.width + x0;
      const top = img.data[i] * (1 - fx) + img.data[i + 1] * fx;
      const bottom = img.data[i + img.width] * (1 - fx) + img.data[i + img.width + 1] * fx;
      out.data[y * img.width + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return out;
}

/** Light scanner noise: a few isolated dark specks. Deterministic. */
export function specks(img: GrayImage, count: number, seed = 1): void {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    const x = Math.floor(next() * img.width);
    const y = Math.floor(next() * img.height);
    img.data[y * img.width + x] = 60;
  }
}

export function copyImage(img: GrayImage): GrayImage {
  return { width: img.width, height: img.height, data: img.data.slice() };
}
