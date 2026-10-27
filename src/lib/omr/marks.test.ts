import { describe, expect, it } from "vitest";
import { readChoice, readWriteIn } from "./decide";
import { addedInk, choiceInk, coverBlank, studentInkMask } from "./ink";
import { applyAffine, prepareBlankPage, registerPage } from "./register";
import { blankPage, copyImage, disc, fillRect, ring, specks, stroke, textLine, warp } from "./synthetic";
import type { GrayImage, SpotBox } from "./types";

// A letter page at 150 dpi with printed lines, one choice question (options A–D) and one write-in line.
const W = 1275;
const H = 1650;
const OPTION_Y = 400;
const OPTION_X = [150, 400, 650, 900];
const LETTERS = ["A", "B", "C", "D"];

function worksheet(): GrayImage {
  const img = blankPage(W, H);
  textLine(img, 100, 100, 40); // title
  textLine(img, 100, 160, 25); // name line
  textLine(img, 100, 340, 60); // question 1
  for (const x of OPTION_X) {
    fillRect(img, x, OPTION_Y, 10, 14); // the option letter
    fillRect(img, x + 13, OPTION_Y + 10, 3, 4); // its ")"
    textLine(img, x + 25, OPTION_Y, 12);
  }
  textLine(img, 100, 600, 50); // question 2
  fillRect(img, 300, 720, 400, 2); // the answer line
  for (let y = 900; y < 1500; y += 40) textLine(img, 100, y, 70);
  return img;
}

/** Each option's spot: the letter with room around it for a circle, a tick or a filled bubble. */
function optionBox(i: number): SpotBox {
  const x = OPTION_X[i];
  return { x: (x - 30) / W, y: (OPTION_Y - 14) / H, w: 120 / W, h: 42 / H };
}
const WRITE_BOX: SpotBox = { x: 300 / W, y: 670 / H, w: 400 / W, h: 58 / H };

function circleOption(img: GrayImage, i: number): void {
  ring(img, OPTION_X[i] + 7, OPTION_Y + 7, 17);
}

function readOptions(blank: GrayImage, student: GrayImage) {
  const reg = registerPage(prepareBlankPage(blank), student);
  const covered = coverBlank(blank);
  const ink = studentInkMask(student);
  return {
    reg,
    choice: readChoice(choiceInk(covered, ink, reg.px, LETTERS.map((_, i) => optionBox(i))).map((score, i) => ({ value: LETTERS[i], ink: score.fraction }))),
    write: addedInk(covered, ink, reg.px, WRITE_BOX),
  };
}

describe("registration", () => {
  const blank = worksheet();

  it("lines up an identical page exactly", () => {
    const reg = registerPage(prepareBlankPage(blank), copyImage(blank));
    expect(reg.ok).toBe(true);
    expect(reg.score).toBeGreaterThan(0.95);
    expect(reg.angleDeg).toBeCloseTo(0, 1);
    expect(reg.scale).toBeCloseTo(1, 2);
    const [u, v] = applyAffine(reg.map, 0.5, 0.5);
    expect(u).toBeCloseTo(0.5, 2);
    expect(v).toBeCloseTo(0.5, 2);
  });

  it.each([
    { dx: 37, dy: -22, angleDeg: 0, scale: 1 },
    { dx: -15, dy: 30, angleDeg: 2.3, scale: 1 },
    { dx: 10, dy: 12, angleDeg: -4, scale: 0.97 },
    { dx: -40, dy: -35, angleDeg: 1.2, scale: 1.04 },
  ])("recovers a scanner shift/rotation/scale %o", (t) => {
    const scanned = warp(blank, t);
    const started = performance.now();
    const reg = registerPage(prepareBlankPage(blank), scanned);
    const ms = performance.now() - started;
    expect(reg.ok).toBe(true);
    expect(reg.angleDeg).toBeCloseTo(t.angleDeg, 0);
    expect(Math.abs(reg.scale - t.scale)).toBeLessThan(0.01);
    // A point of the blank lands where the warp put it (within a pixel or two).
    const [u, v] = applyAffine(reg.map, OPTION_X[2] / W, OPTION_Y / H);
    const theta = (t.angleDeg * Math.PI) / 180;
    const px = OPTION_X[2] - W / 2;
    const py = OPTION_Y - H / 2;
    const ex = t.scale * (Math.cos(theta) * px - Math.sin(theta) * py) + W / 2 + t.dx;
    const ey = t.scale * (Math.sin(theta) * px + Math.cos(theta) * py) + H / 2 + t.dy;
    expect(Math.abs(u * W - ex)).toBeLessThan(2.5);
    expect(Math.abs(v * H - ey)).toBeLessThan(2.5);
    expect(ms).toBeLessThan(3000); // generous for a loaded CI machine; about 0.2–0.5 s normally
  });

  it("lines up a page scanned upside down", () => {
    const reg = registerPage(prepareBlankPage(blank), warp(blank, { angleDeg: 180.5, dx: 8, dy: -6 }));
    expect(reg.ok).toBe(true);
    expect(Math.abs(Math.abs(reg.angleDeg) - 180)).toBeLessThan(1.5);
  });

  it("refuses a page that is not this worksheet", () => {
    const other = blankPage(W, H);
    for (let y = 120; y < 1500; y += 55) textLine(other, 300, y, 30, 14, 20);
    expect(registerPage(prepareBlankPage(blank), other).ok).toBe(false);
    expect(registerPage(prepareBlankPage(blank), blankPage(W, H)).ok).toBe(false);
  });
});

describe("reading marks", () => {
  const blank = worksheet();

  it("an unmarked paper reads as blank", () => {
    const { choice, write } = readOptions(blank, warp(blank, { dx: 12, dy: -9, angleDeg: 0.8 }));
    expect(choice).toMatchObject({ marked: [], confidence: "high", review: "none" });
    expect(readWriteIn(write.pixels, write.fraction).written).toBe(false);
  });

  it("a circle on B reads B, also after a scanner warp", () => {
    const student = copyImage(blank);
    circleOption(student, 1);
    const { choice } = readOptions(blank, warp(student, { dx: -20, dy: 14, angleDeg: -2.5, scale: 1.02 }));
    expect(choice).toMatchObject({ marked: ["B"], confidence: "high", review: "none" });
    expect(choice.marksSeen).toMatch(/^B: strong mark/);
  });

  it("a filled bubble or a tick next to the letter counts as a mark", () => {
    const filled = copyImage(blank);
    disc(filled, OPTION_X[3] - 16, OPTION_Y + 7, 8);
    expect(readOptions(blank, filled).choice.marked).toEqual(["D"]);
    const ticked = copyImage(blank);
    stroke(ticked, OPTION_X[0] - 20, OPTION_Y + 4, OPTION_X[0] - 12, OPTION_Y + 14);
    stroke(ticked, OPTION_X[0] - 12, OPTION_Y + 14, OPTION_X[0] + 2, OPTION_Y - 8);
    expect(readOptions(blank, ticked).choice.marked).toEqual(["A"]);
  });

  it("two marked options read as both, for the teacher to check", () => {
    const student = copyImage(blank);
    circleOption(student, 1);
    circleOption(student, 2);
    const { choice } = readOptions(blank, warp(student, { dx: 5, dy: 5 }));
    expect(choice).toMatchObject({ marked: ["B", "C"], review: "multiple_answers" });
  });

  it("a crossed-out choice next to a circled one goes to the teacher", () => {
    const student = copyImage(blank);
    circleOption(student, 0);
    stroke(student, OPTION_X[0] - 12, OPTION_Y - 6, OPTION_X[0] + 26, OPTION_Y + 22);
    stroke(student, OPTION_X[0] - 12, OPTION_Y + 22, OPTION_X[0] + 26, OPTION_Y - 6);
    circleOption(student, 2);
    const { choice } = readOptions(blank, student);
    expect(choice.marked).toEqual(["A", "C"]);
    expect(choice.review).not.toBe("none");
  });

  it("a faint stray dot is not a mark, and scanner specks are ignored", () => {
    const student = copyImage(blank);
    disc(student, OPTION_X[1] + 40, OPTION_Y + 20, 1.5, 120);
    specks(student, 4000, 7);
    const { choice, write } = readOptions(blank, warp(student, { dx: 3, dy: -4, angleDeg: 0.3 }));
    expect(choice.marked).toEqual([]);
    expect(readWriteIn(write.pixels, write.fraction).written).toBe(false);
  });

  it("writing on the answer line reads as written", () => {
    const student = copyImage(blank);
    // A short handwritten word above the line.
    stroke(student, 320, 715, 335, 680);
    stroke(student, 335, 680, 350, 715);
    stroke(student, 360, 715, 360, 685);
    stroke(student, 360, 685, 385, 700);
    stroke(student, 400, 700, 430, 700);
    const { write } = readOptions(blank, warp(student, { dx: -8, dy: 11, angleDeg: 1.5 }));
    expect(readWriteIn(write.pixels, write.fraction)).toMatchObject({ written: true, confidence: "high" });
  });
});

describe("options printed one under another (a. b. c. d.)", () => {
  // As on a typical quiz: the letters in a column 26 px (0.17 in) apart, each spot as tall as its line.
  const COLUMN_X = 160;
  const ROW_Y = [400, 426, 452, 478];
  const stacked = (() => {
    const img = blankPage(W, H);
    textLine(img, 100, 340, 60);
    for (const y of ROW_Y) {
      fillRect(img, COLUMN_X, y, 9, 12);
      fillRect(img, COLUMN_X + 11, y + 9, 3, 3);
      textLine(img, COLUMN_X + 30, y, 30);
    }
    for (let y = 700; y < 1500; y += 40) textLine(img, 100, y, 70);
    return img;
  })();
  const boxes: SpotBox[] = ROW_Y.map((y) => ({ x: (COLUMN_X - 30) / W, y: (y - 7) / H, w: 90 / W, h: 26 / H }));
  const read = (student: GrayImage) => {
    const reg = registerPage(prepareBlankPage(stacked), student);
    const covered = coverBlank(stacked);
    const ink = studentInkMask(student);
    return {
      perBox: boxes.map((box) => addedInk(covered, ink, reg.px, box).fraction),
      choice: readChoice(choiceInk(covered, ink, reg.px, boxes).map((score, i) => ({ value: LETTERS[i], ink: score.fraction }))),
    };
  };

  it("a big circle around a. that dips into b.'s line reads a. alone", () => {
    const student = copyImage(stacked);
    ring(student, COLUMN_X + 6, ROW_Y[0] + 8, 19);
    const { perBox, choice } = read(warp(student, { dx: 6, dy: -4, angleDeg: 0.6 }));
    expect(perBox[1]).toBeGreaterThan(0.005); // counted box by box, the circle's bottom would show on b.
    expect(choice).toMatchObject({ marked: ["A"], confidence: "high", review: "none" });
    expect(choice.marksSeen).toMatch(/^A: .*others clean$/);
  });

  it("a circle around d. that reaches up into c. reads d. alone", () => {
    const student = copyImage(stacked);
    ring(student, COLUMN_X + 6, ROW_Y[3] + 6, 20);
    expect(read(student).choice).toMatchObject({ marked: ["D"], confidence: "high" });
  });

  it("two separate circles still read as two answers", () => {
    const student = copyImage(stacked);
    ring(student, COLUMN_X + 6, ROW_Y[0] + 6, 14);
    ring(student, COLUMN_X + 6, ROW_Y[2] + 6, 14);
    expect(read(student).choice).toMatchObject({ marked: ["A", "C"], review: "multiple_answers" });
  });

  it("a line drawn down through every option counts where it falls, not for one option", () => {
    const student = copyImage(stacked);
    stroke(student, COLUMN_X - 12, ROW_Y[0] - 4, COLUMN_X - 12, ROW_Y[3] + 16);
    const { perBox, choice } = read(student);
    expect(choice.marked.length).not.toBe(1);
    expect(perBox.every((f) => f > 0)).toBe(true);
  });
});

describe("readChoice", () => {
  it("is unsure when the strongest option is barely above another", () => {
    expect(readChoice([{ value: "A", ink: 0.02 }, { value: "B", ink: 0.012 }, { value: "C", ink: 0 }])).toMatchObject({
      marked: ["A"], confidence: "low", review: "ambiguous_reading",
    });
  });

  it("reports a faint mark without choosing it", () => {
    expect(readChoice([{ value: "A", ink: 0.008 }, { value: "B", ink: 0 }])).toMatchObject({
      marked: [], confidence: "low", review: "ambiguous_reading",
    });
  });

  it("describes what it saw", () => {
    expect(readChoice([{ value: "A", ink: 0 }, { value: "B", ink: 0.06 }, { value: "C", ink: 0 }]).marksSeen).toBe("B: strong mark (6.0%); others clean");
    expect(readChoice([{ value: "A", ink: 0 }, { value: "B", ink: 0 }]).marksSeen).toBe("no marks; every option clean");
  });
});
