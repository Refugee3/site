import type { GrayImage } from "./types";

// Pure image primitives for mark detection: masks of dark pixels ("ink"), block-OR downscaling, dilation and sampling.
// Everything works on typed arrays; nothing allocates per pixel.

/** A binary image: 1 = ink, 0 = paper. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Gray levels below this count as ink on a student's page (pencil included). */
export const INK_THRESHOLD = 170;
/** On the blank, lighter pixels count too, so the anti-aliased edges of printed text are covered. */
export const BLANK_INK_THRESHOLD = 200;

export function grayImage(width: number, height: number, fill = 255): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

/** RGBA (as from a canvas) → gray (ITU-R 601 luma), with transparent pixels as white paper. */
export function grayFromRgba(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const alpha = rgba[j + 3];
    const luma = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    data[i] = Math.round(255 - ((255 - luma) * alpha) / 255);
  }
  return { width, height, data };
}

export function inkMask(img: GrayImage, threshold = INK_THRESHOLD): Mask {
  const data = new Uint8Array(img.width * img.height);
  const src = img.data;
  for (let i = 0; i < data.length; i++) data[i] = src[i] < threshold ? 1 : 0;
  return { width: img.width, height: img.height, data };
}

/** Each output pixel is ink when any pixel of its f×f block is (thin lines survive). */
export function orDownscale(m: Mask, f: number): Mask {
  if (f === 1) return m;
  const width = Math.ceil(m.width / f);
  const height = Math.ceil(m.height / f);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    const outRow = Math.floor(y / f) * width;
    for (let x = 0; x < m.width; x++) {
      if (m.data[row + x]) data[outRow + Math.floor(x / f)] = 1;
    }
  }
  return { width, height, data };
}

/** Square dilation by `r` pixels (a (2r+1)² structuring element), separable: rows, then columns. */
export function dilate(m: Mask, r: number): Mask {
  if (r <= 0) return m;
  const { width, height } = m;
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    // A running count of ink in the window [x - r, x + r].
    for (let x = 0; x < Math.min(r, width); x++) count += m.data[row + x];
    for (let x = 0; x < width; x++) {
      const add = x + r;
      if (add < width) count += m.data[row + add];
      const drop = x - r - 1;
      if (drop >= 0) count -= m.data[row + drop];
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  const data = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, height); y++) count += tmp[y * width + x];
    for (let y = 0; y < height; y++) {
      const add = y + r;
      if (add < height) count += tmp[add * width + x];
      const drop = y - r - 1;
      if (drop >= 0) count -= tmp[drop * width + x];
      data[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return { width, height, data };
}

/** The coordinates of up to `max` ink pixels, spread evenly over all of them (x, y interleaved). */
export function inkPoints(m: Mask, max: number): Float64Array {
  let total = 0;
  for (let i = 0; i < m.data.length; i++) total += m.data[i];
  const step = Math.max(1, total / max);
  const out: number[] = [];
  let seen = 0;
  let next = 0;
  for (let i = 0; i < m.data.length; i++) {
    if (!m.data[i]) continue;
    if (seen >= next) {
      out.push(i % m.width, Math.floor(i / m.width));
      next += step;
    }
    seen++;
  }
  return Float64Array.from(out);
}

export function countInk(m: Mask): number {
  let total = 0;
  for (let i = 0; i < m.data.length; i++) total += m.data[i];
  return total;
}

/** Scales a gray image down by an integer factor (block average). */
export function downscaleGray(img: GrayImage, f: number): GrayImage {
  if (f === 1) return img;
  const width = Math.max(1, Math.floor(img.width / f));
  const height = Math.max(1, Math.floor(img.height / f));
  const data = new Uint8Array(width * height);
  const area = f * f;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * img.width + x * f;
        for (let dx = 0; dx < f; dx++) sum += img.data[row + dx];
      }
      data[y * width + x] = Math.round(sum / area);
    }
  }
  return { width, height, data };
}
