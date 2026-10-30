import { describe, expect, it } from "vitest";
import { coverBlank } from "../ink";
import { prepareBlankPage } from "../register";
import { blankPage, copyImage, specks, stroke, textLine, warp } from "../synthetic";
import type { GrayImage } from "../types";
import { matchPage, prepareMatchBlank } from "./match";

// Matching scanned pages to blank worksheet pages on synthetic rasters: printed lines as blocks, pen strokes as handwriting.

const W = 1275;
const H = 1650;

/** A worksheet page: a title and lines of "text" at the given heights (pixels), each `chars` long. */
function page(lines: Array<[y: number, chars: number]>): GrayImage {
  const img = blankPage(W, H);
  textLine(img, 120, 80, 30, 14, 22);
  for (const [y, chars] of lines) textLine(img, 120, y, chars);
  return img;
}

const PAGE_1 = page([[200, 60], [260, 40], [420, 70], [600, 55], [640, 30], [900, 64], [1200, 50]]);
const PAGE_2 = page([[180, 45], [330, 70], [380, 66], [700, 40], [1000, 70], [1050, 20], [1400, 58]]);
/** A sparse page: the title and one question. */
const PAGE_3 = page([[220, 50]]);

const blanks = [PAGE_1, PAGE_2, PAGE_3].map((g) => prepareMatchBlank(g, { prepared: prepareBlankPage(g), covered: coverBlank(g).covered }, [
  { x: 0.08, y: 0.16, w: 0.84, h: 0.25 },
]));

/** A student's copy: handwriting below the question (in the answer area), scanned with a small shift and rotation. */
function scanned(p: GrayImage, o: { angleDeg?: number; dx?: number; dy?: number } = {}): GrayImage {
  const img = copyImage(p);
  stroke(img, 150, 330, 700, 345);
  stroke(img, 160, 380, 640, 372);
  specks(img, 40);
  return warp(img, { angleDeg: o.angleDeg ?? 0.8, dx: o.dx ?? 9, dy: o.dy ?? -7 });
}

describe("matching a scanned page to the blank worksheet's pages", () => {
  it("finds each page, at once when it is the page expected next", () => {
    const one = matchPage(blanks, scanned(PAGE_1), 1);
    expect(one).toMatchObject({ blankPage: 1, ambiguous: false, tried: 1 });
    expect(one.score).toBeGreaterThan(0.8);
    expect(one.reg?.ok).toBe(true);
    // Not the page expected: every page is tried, the right one wins clearly.
    const two = matchPage(blanks, scanned(PAGE_2, { angleDeg: -1.2, dx: -6 }), 1);
    expect(two).toMatchObject({ blankPage: 2, ambiguous: false });
    expect(two.tried).toBeGreaterThan(1);
    expect(two.second).toBeLessThan(0.5);
  });

  it("a sparse blank page doesn't match a full page, though its few lines land on print anywhere", () => {
    const m = matchPage(blanks, scanned(PAGE_2), 3);
    expect(m.blankPage).toBe(2);
    expect(matchPage(blanks, scanned(PAGE_3), 3).blankPage).toBe(3);
  });

  it("a blank page is blank, and another worksheet's page matches nothing", () => {
    expect(matchPage(blanks, blankPage(W, H), 1)).toMatchObject({ blankPage: null, ink: 0, tried: 0 });
    const other = page([[300, 20], [310, 20], [500, 70], [520, 70], [540, 70], [1100, 30], [1500, 70]]);
    expect(matchPage(blanks, warp(other, { dx: 30, dy: 40 }), 1).blankPage).toBeNull();
  });
});
