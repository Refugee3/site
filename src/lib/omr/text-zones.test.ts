import { describe, expect, it } from "vitest";
import { makeWorksheet, MIXED_WORKSHEET, PLANTS_QUIZ } from "./fixtures";
import { openPdf, splitItem } from "./pdf-raster";
import { detectSpotsFromText, normalizeLabel, type TextPage } from "./text-zones";
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
