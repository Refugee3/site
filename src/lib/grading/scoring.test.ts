import { describe, expect, it } from "vitest";
import { accuracyQuarters, completionQuarters, computeScore, percentTenths, roundHalfUpDiv } from "@/lib/grading/scoring";
import { makeJudgment, makeKeyItem, makeResult } from "@/lib/grading/test-utils";
import type { Attempt, Correctness, GradingMode, ItemJudgment, KeyItem, SubmissionItem } from "@/lib/types";

const COMPLETION = { gradingMode: "completion" as GradingMode, accuracyWeight: 50 };
const ACCURACY = { gradingMode: "accuracy" as GradingMode, accuracyWeight: 50 };
const blended = (accuracyWeight: number) => ({ gradingMode: "blended" as GradingMode, accuracyWeight });

function results(entries: Array<[KeyItem, ItemJudgment | null, number?]>): Map<string, SubmissionItem> {
  return new Map(entries.map(([item, judgment, override]) => [item.id, makeResult(item.id, judgment, override ?? null)]));
}

/** Score of a single item with one judgment. */
function scoreOne(item: Partial<KeyItem>, judgment: Partial<ItemJudgment>, mode: { gradingMode: GradingMode; accuracyWeight: number }) {
  const keyItem = makeKeyItem(item);
  return computeScore([keyItem], results([[keyItem, makeJudgment(judgment)]]), mode, null).items[0].earnedCenti;
}

describe("completionQuarters", () => {
  it.each<[Attempt, number]>([["complete", 4], ["partial", 2], ["none", 0]])("%s → %d", (attempt, quarters) => {
    expect(completionQuarters(attempt)).toBe(quarters);
  });
});

describe("accuracyQuarters", () => {
  it.each<[Correctness, number]>([
    ["correct", 4], ["minor_error", 3], ["partially_correct", 2], ["major_error", 1],
    ["incorrect", 0], ["no_answer", 0], ["cannot_judge", 0],
  ])("with partial credit, %s → %d", (correctness, quarters) => {
    expect(accuracyQuarters({ attempt: "complete", correctness }, true)).toBe(quarters);
  });

  it.each<[Correctness, number]>([
    ["correct", 4], ["minor_error", 0], ["partially_correct", 0], ["major_error", 0], ["incorrect", 0], ["cannot_judge", 0],
  ])("without partial credit, %s → %d", (correctness, quarters) => {
    expect(accuracyQuarters({ attempt: "complete", correctness }, false)).toBe(quarters);
  });

  it("gives nothing for an item that was not attempted, whatever the correctness says", () => {
    expect(accuracyQuarters({ attempt: "none", correctness: "correct" }, true)).toBe(0);
    expect(accuracyQuarters({ attempt: "none", correctness: "correct" }, false)).toBe(0);
  });
});

describe("roundHalfUpDiv", () => {
  it.each([
    [0, 4, 0], [1, 4, 0], [2, 4, 1], [3, 4, 1], [5, 4, 1], [6, 4, 2], [7, 4, 2],
    [5, 2, 3], [7, 2, 4], [7, 3, 2], [8, 3, 3], [64000, 400, 160], [1, 3, 0], [2, 3, 1],
    [999_500, 1000, 1000], [999_499, 1000, 999], [12, 12, 1],
  ])("%d / %d → %d", (num, den, expected) => {
    expect(roundHalfUpDiv(num, den)).toBe(expected);
  });

  it("rejects a negative numerator or a non-positive denominator", () => {
    expect(() => roundHalfUpDiv(-1, 4)).toThrow(RangeError);
    expect(() => roundHalfUpDiv(1, 0)).toThrow(RangeError);
  });
});

describe("percentTenths", () => {
  it("rounds half up to tenths of a percent", () => {
    expect(percentTenths(1, 3)).toBe(333);
    expect(percentTenths(2, 3)).toBe(667);
    expect(percentTenths(1, 8)).toBe(125);
    expect(percentTenths(160, 200)).toBe(800);
    expect(percentTenths(0, 200)).toBe(0);
  });

  it("is null for an empty key", () => {
    expect(percentTenths(0, 0)).toBeNull();
  });
});

describe("computeScore worked examples", () => {
  it("2 pt item, blended w=40, complete + partially_correct → 160", () => {
    expect(scoreOne({ pointsCenti: 200 }, { attempt: "complete", correctness: "partially_correct" }, blended(40))).toBe(160);
  });

  it("1 pt multiple choice without partial credit, accuracy mode, minor_error → 0", () => {
    const item = { pointsCenti: 100, answerType: "multiple_choice" as const, partialCredit: false };
    expect(scoreOne(item, { attempt: "complete", correctness: "minor_error" }, ACCURACY)).toBe(0);
  });

  it("1 pt, completion mode, partial attempt → 50", () => {
    expect(scoreOne({ pointsCenti: 100 }, { attempt: "partial", correctness: "partially_correct" }, COMPLETION)).toBe(50);
  });
});

describe("computeScore modes", () => {
  const judgment = { attempt: "complete" as const, correctness: "major_error" as const };

  it("completion mode credits the attempt only", () => {
    expect(scoreOne({ pointsCenti: 300 }, judgment, COMPLETION)).toBe(300);
    expect(scoreOne({ pointsCenti: 300 }, { attempt: "none", correctness: "no_answer" }, COMPLETION)).toBe(0);
  });

  it("accuracy mode credits correctness only", () => {
    expect(scoreOne({ pointsCenti: 300 }, judgment, ACCURACY)).toBe(75);
    expect(scoreOne({ pointsCenti: 300 }, { attempt: "complete", correctness: "correct" }, ACCURACY)).toBe(300);
  });

  it("blended weight 0 equals completion and weight 100 equals accuracy", () => {
    expect(scoreOne({ pointsCenti: 300 }, judgment, blended(0))).toBe(300);
    expect(scoreOne({ pointsCenti: 300 }, judgment, blended(100))).toBe(75);
  });

  it("blended weight 40 mixes both: 300 × (60·4 + 40·1) / 400 = 210", () => {
    expect(scoreOne({ pointsCenti: 300 }, judgment, blended(40))).toBe(210);
  });

  it("ignores the stored weight outside blended mode", () => {
    expect(scoreOne({ pointsCenti: 300 }, judgment, { gradingMode: "completion", accuracyWeight: 100 })).toBe(300);
    expect(scoreOne({ pointsCenti: 300 }, judgment, { gradingMode: "accuracy", accuracyWeight: 0 })).toBe(75);
  });

  it("partial_credit=false makes accuracy all-or-nothing but keeps completion credit", () => {
    const item = { pointsCenti: 100, partialCredit: false };
    expect(scoreOne(item, { attempt: "complete", correctness: "partially_correct" }, ACCURACY)).toBe(0);
    expect(scoreOne(item, { attempt: "complete", correctness: "correct" }, ACCURACY)).toBe(100);
    expect(scoreOne(item, { attempt: "complete", correctness: "partially_correct" }, blended(40))).toBe(60);
  });

  it("an unreadable attempt keeps completion credit but earns no accuracy", () => {
    const unreadable = { attempt: "complete" as const, correctness: "cannot_judge" as const };
    expect(scoreOne({ pointsCenti: 100 }, unreadable, COMPLETION)).toBe(100);
    expect(scoreOne({ pointsCenti: 100 }, unreadable, ACCURACY)).toBe(0);
  });
});

describe("computeScore totals", () => {
  it("leaves unjudged items at 0 with a null computed score and counts judged items", () => {
    const [a, b, c] = [makeKeyItem({ pointsCenti: 100 }), makeKeyItem({ pointsCenti: 200 }), makeKeyItem({ pointsCenti: 300 })];
    const score = computeScore([a, b, c], results([[a, makeJudgment()], [b, null]]), COMPLETION, null);
    expect(score.items.map((item) => item.computedCenti)).toEqual([100, null, null]);
    expect(score.items.map((item) => item.earnedCenti)).toEqual([100, 0, 0]);
    expect(score).toMatchObject({ earnedCenti: 100, maxCenti: 600, percentTenths: 167, judgedCount: 1, totalOverridden: false });
  });

  it("clamps item overrides to 0..points and uses them even without a judgment", () => {
    const [a, b, c] = [makeKeyItem({ pointsCenti: 200 }), makeKeyItem({ pointsCenti: 200 }), makeKeyItem({ pointsCenti: 200 })];
    const score = computeScore([a, b, c], results([[a, makeJudgment(), 500], [b, null, 150], [c, makeJudgment(), 0]]), COMPLETION, null);
    expect(score.items.map((item) => [item.computedCenti, item.earnedCenti, item.overridden])).toEqual([
      [200, 200, true], [null, 150, true], [200, 0, true],
    ]);
    expect(score.earnedCenti).toBe(350);
  });

  it("applies a total override clamped to 0..max without changing the item scores", () => {
    const item = makeKeyItem({ pointsCenti: 400 });
    const map = results([[item, makeJudgment({ attempt: "partial", correctness: "partially_correct" })]]);
    const over = computeScore([item], map, COMPLETION, 9_999);
    expect(over).toMatchObject({ earnedCenti: 400, percentTenths: 1000, totalOverridden: true });
    expect(over.items[0].earnedCenti).toBe(200);
    expect(computeScore([item], map, COMPLETION, 0)).toMatchObject({ earnedCenti: 0, percentTenths: 0, totalOverridden: true });
    expect(computeScore([item], map, COMPLETION, 123)).toMatchObject({ earnedCenti: 123, percentTenths: 308 });
  });

  it("reports completion and accuracy totals that ignore overrides and the mode", () => {
    const [a, b] = [makeKeyItem({ pointsCenti: 100 }), makeKeyItem({ pointsCenti: 100 })];
    const map = results([
      [a, makeJudgment({ attempt: "complete", correctness: "incorrect" }), 100],
      [b, makeJudgment({ attempt: "partial", correctness: "partially_correct" })],
    ]);
    for (const mode of [COMPLETION, ACCURACY, blended(40)]) {
      expect(computeScore([a, b], map, mode, 0)).toMatchObject({ completionCenti: 150, accuracyCenti: 50 });
    }
  });

  it("has a total equal to the sum of the rounded item scores", () => {
    const points = [33, 1, 7, 99_999, 250, 13, 101];
    const items = points.map((pointsCenti) => makeKeyItem({ pointsCenti }));
    const judgments: Array<Partial<ItemJudgment>> = [
      { attempt: "partial", correctness: "partially_correct" }, { attempt: "complete", correctness: "minor_error" },
      { attempt: "complete", correctness: "major_error" }, { attempt: "partial", correctness: "major_error" },
      { attempt: "complete", correctness: "correct" }, { attempt: "none", correctness: "no_answer" },
      { attempt: "partial", correctness: "minor_error" },
    ];
    const map = results(items.map((item, index) => [item, makeJudgment(judgments[index])]));
    for (const mode of [COMPLETION, ACCURACY, blended(35), blended(40), blended(95)]) {
      const score = computeScore(items, map, mode, null);
      expect(score.earnedCenti).toBe(score.items.reduce((sum, item) => sum + item.earnedCenti, 0));
      expect(score.items.every((item) => Number.isInteger(item.earnedCenti))).toBe(true);
    }
  });

  it("has a null percent when the key is worth nothing", () => {
    expect(computeScore([], new Map(), COMPLETION, null)).toEqual({
      items: [], earnedCenti: 0, maxCenti: 0, percentTenths: null, completionCenti: 0, accuracyCenti: 0,
      totalOverridden: false, judgedCount: 0,
    });
    expect(computeScore([], new Map(), COMPLETION, 500)).toMatchObject({ earnedCenti: 0, percentTenths: null });
  });
});
