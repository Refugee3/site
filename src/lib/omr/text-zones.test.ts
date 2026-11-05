import { describe, expect, it } from "vitest";
import { makeWorksheet, MIXED_WORKSHEET, PLANTS_QUIZ } from "./fixtures";
import { openPdf, splitItem } from "./pdf-raster";
import { detectSpotsFromText, normalizeLabel, type TextPage, type TextToken } from "./text-zones";
import type { QuestionSpots, SpotBox } from "./types";

async function textPages(pdf: Uint8Array): Promise<TextPage[]> {
  const doc = await openPdf(pdf, { fonts: true });
  try {
    const pages: TextPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const size = await doc.pageSize(n);
      pages.push({ tokens: await doc.textTokens(n), widthPt: size.width, heightPt: size.height });
    }
    return pages;
  } finally {
    await doc.close();
  }
}

/** Whether a printed anchor (PDF points, baseline) lies inside a normalized box of a letter page. */
function contains(box: SpotBox, a: { x: number; y: number; w: number }): boolean {
  const u = (a.x + a.w / 2) / 612;
  const v = (792 - a.y - 4) / 792;
  return u >= box.x && u <= box.x + box.w && v >= box.y && v <= box.y + box.h;
}

function byLabel(spots: QuestionSpots[], label: string): QuestionSpots {
  const spot = spots.find((s) => s.label === label);
  if (!spot) throw new Error(`no spot for ${label}: ${spots.map((s) => s.label).join(", ")}`);
  return spot;
}

describe("answer spots from the text layer", () => {
  it("finds A–D, True/False, a blank, check boxes, circle-the-word and an open question", async () => {
    const { pdf, layout } = await makeWorksheet(MIXED_WORKSHEET);
    const spots = detectSpotsFromText(await textPages(pdf), []);
    expect(spots.map((s) => [s.label, s.kind])).toEqual([
      ["1", "choice"], ["2", "choice"], ["3", "write_in"], ["4", "choice"], ["5", "choice"], ["6", "write_in"],
    ]);
    const q1 = byLabel(spots, "1");
    expect(q1.options.map((o) => o.value)).toEqual(["A", "B", "C", "D"]);
    for (const o of q1.options) expect(contains(o.box, layout.questions["1"].options[o.value])).toBe(true);
    expect(byLabel(spots, "2").options.map((o) => o.value)).toEqual(["True", "False"]);
    expect(contains(byLabel(spots, "3").boxes[0], layout.questions["3"].blank!)).toBe(true);
    expect(byLabel(spots, "4").options.map((o) => o.value)).toEqual(["Yes", "No"]);
    for (const o of byLabel(spots, "4").options) expect(contains(o.box, layout.questions["4"].options[o.value])).toBe(true);
    expect(byLabel(spots, "5").options.map((o) => o.value)).toEqual(["is", "are"]);
    for (const o of byLabel(spots, "5").options) expect(contains(o.box, layout.questions["5"].options[o.value])).toBe(true);
    // The open question is answered in the room under it.
    const room = layout.questions["6"].room!;
    const area = byLabel(spots, "6").boxes[0];
    expect(area.y).toBeLessThan((792 - room.y) / 792 + 0.02);
    expect(area.y + area.h).toBeGreaterThan((792 - room.y + room.h) / 792 - 0.05);
    // Option spots on one line never overlap.
    const opts = q1.options.map((o) => o.box);
    for (let i = 1; i < opts.length; i++) expect(opts[i - 1].x + opts[i - 1].w).toBeLessThanOrEqual(opts[i].x + 1e-9);
  });

  it("follows the key: sub-questions, answer kinds and links by label", async () => {
    const { pdf } = await makeWorksheet(PLANTS_QUIZ);
    const spots = detectSpotsFromText(await textPages(pdf), [
      { label: "1", answerType: "multiple_choice" },
      { label: "2", answerType: "numeric" },
      { label: "3a", answerType: "short_answer" },
      { label: "3b", answerType: "short_answer" },
      { label: "4", answerType: "diagram" },
      { label: "5", answerType: "long_answer" },
    ]);
    expect(spots.map((s) => [s.label, s.itemLabel, s.kind])).toEqual([
      ["1", "1", "choice"], ["2", "2", "write_in"], ["3a", "3a", "write_in"], ["3b", "3b", "write_in"],
      ["4", "4", "diagram"], ["5", "5", "write_in"],
    ]);
    expect(byLabel(spots, "1").options.map((o) => o.value)).toEqual(["A", "B", "C", "D"]);
    // "3/x" in question 2 is not a choice: the question has a blank.
    expect(byLabel(spots, "2").options).toEqual([]);
  });

  describe("a scanned quiz (text from the scanner's text recognition)", () => {
    // Letter page in points. Questions at x=100; options a.–d. stacked 15 pt apart at x≈117, never exactly aligned on a scan.
    const W = 612;
    const H = 792;
    const tok = (text: string, x: number, y: number, w = 7.2): TextToken => ({ text, x: x / W, y: y / H, w: w / W, h: 9 / H, baseline: (y + 7) / H });
    const JITTER = [0, 0.3, -0.2, 0.5, 0.1, -0.4, 0.25, 0.6];
    const question = (label: string | null, top: number, n: number): TextToken[] => {
      const stem = [...(label ? [tok(label, 100, top)] : []), tok("Which", 117, top, 30), tok("is", 150, top, 8), tok("right?", 160, top, 26)];
      const options = ["a.", "b.", "c.", "d."].flatMap((letter, i) => {
        const y = top + 15 * (i + 1);
        return [tok(letter, 117 + JITTER[(n + i) % JITTER.length], y), tok("Option", 134, y, 30), tok("text", 167, y, 18)];
      });
      return [...stem, ...options];
    };
    const key = ["1", "2", "3", "4"].map((label) => ({ label, answerType: "multiple_choice" as const }));

    it("keeps each option's box around its own letter when the letters aren't exactly in line", () => {
      const page: TextPage = { tokens: [...question("1.", 130, 0), ...question("2.", 230, 1)], widthPt: W, heightPt: H };
      const spots = detectSpotsFromText([page], key);
      expect(spots.map((s) => s.label)).toEqual(["1", "2"]);
      for (const spot of spots) {
        expect(spot.options.map((o) => o.value)).toEqual(["A", "B", "C", "D"]);
        const letters = page.tokens.filter((t) => /^[a-d]\.$/.test(t.text) && t.y >= spot.options[0].box.y && t.y <= spot.options[3].box.y + spot.options[3].box.h);
        spot.options.forEach((o, i) => {
          const letter = letters[i];
          // Room for a circle on both sides of the letter: never cut short sideways by the option above or below.
          expect(o.box.x).toBeLessThan(letter.x - 0.1 * 72 / W);
          expect(o.box.x + o.box.w).toBeGreaterThan(letter.x + letter.w + 0.2 * 72 / W);
          expect(o.box.y).toBeLessThanOrEqual(letter.y + letter.h / 2);
          expect(o.box.y + o.box.h).toBeGreaterThanOrEqual(letter.y + letter.h / 2);
        });
        for (let i = 1; i < 4; i++) expect(spot.options[i].box.y).toBeGreaterThanOrEqual(spot.options[i - 1].box.y + spot.options[i - 1].box.h - 1e-9);
      }
    });

    it("finds questions whose numbers the text recognition skipped, from the options starting over", () => {
      const page: TextPage = {
        tokens: [...question("1.", 130, 0), ...question(null, 230, 1), ...question("3.", 330, 2), ...question(null, 430, 3)],
        widthPt: W, heightPt: H,
      };
      const spots = detectSpotsFromText([page], key);
      expect(spots.map((s) => s.label)).toEqual(["1", "2", "3", "4"]);
      expect(spots.map((s) => s.options.length)).toEqual([4, 4, 4, 4]);
      // Question 2's options are its own, below its stem.
      expect(byLabel(spots, "2").options[0].box.y).toBeGreaterThan(230 / H);
      expect(byLabel(spots, "1").options[3].box.y).toBeLessThan(230 / H);
    });

    it("doesn't invent questions the key doesn't have", () => {
      const page: TextPage = { tokens: [...question("1.", 130, 0), ...question(null, 230, 1)], widthPt: W, heightPt: H };
      expect(detectSpotsFromText([page], key.slice(0, 1)).map((s) => s.label)).toEqual(["1"]);
    });
  });

  it("splits text items into words, blanks and check boxes", () => {
    const tokens = splitItem({ str: "Name: ____ [ ] Yes", x: 0.1, baseline: 0.5, width: 0.18, fontHeight: 0.02, symbolic: false });
    expect(tokens.map((t) => t.text)).toEqual(["Name:", "____", "☐", "Yes"]);
    expect(tokens[1].x).toBeCloseTo(0.1 + 0.18 * (6 / 18), 5);
    expect(splitItem({ str: "o", x: 0, baseline: 0.5, width: 0.01, fontHeight: 0.02, symbolic: true })[0].text).toBe("☐");
  });

  it("normalizes labels", () => {
    expect(["Q3.", "3)", "Question 3:", "3"].map(normalizeLabel)).toEqual(["3", "3", "3", "3"]);
    expect(normalizeLabel("3 a)")).toBe("3a");
  });
});
