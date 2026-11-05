import { describe, expect, it } from "vitest";
import { makeKeyItem } from "@/lib/grading/test-utils";
import type { NewKeyItem } from "@/lib/types";
import { applyPointsRules, pointsRules } from "./instruction-points";

/** A key item as the AI's reading gives it (KeyItem's extra id, assignment and position are ignored by the code under test). */
function item(o: Partial<NewKeyItem>): NewKeyItem {
  return makeKeyItem(o);
}

describe("pointsRules", () => {
  it("reads a total and a number of parts", () => {
    expect(pointsRules("Question 3 is worth 10 points and is split into 4 parts.")).toEqual([
      { question: "3", totalPoints: 10, parts: 4, partPoints: [], eachPoints: null },
    ]);
    expect(pointsRules("Q2 has three sections, 6 pts total")).toMatchObject([{ question: "2", totalPoints: 6, parts: 3 }]);
  });

  it("reads named parts with their points", () => {
    expect(pointsRules("Question 3 is one question with three parts: 2 points for setting up the equation, 2 for the work, 1 for the final answer. Don't give points for 5c."))
      .toEqual([{
        question: "3", totalPoints: null, parts: 3, eachPoints: null,
        partPoints: [
          { points: 2, name: "setting up the equation" }, { points: 2, name: "work" }, { points: 1, name: "final answer" },
        ],
      }]);
  });

  it("reads per-part points, decimals, several questions and labels at the start of a line", () => {
    expect(pointsRules("Problem 4: 3 parts, 2.5 points each\n5: 8 points\nQuestion 6(b) is worth 4 points")).toEqual([
      { question: "4", totalPoints: null, parts: 3, partPoints: [], eachPoints: 2.5 },
      { question: "5", totalPoints: 8, parts: null, partPoints: [], eachPoints: null },
      { question: "6b", totalPoints: 4, parts: null, partPoints: [], eachPoints: null },
    ]);
  });

  it("ignores sentences without points or parts", () => {
    expect(pointsRules("Units are required. Accept any reasonable synonym on question 2.")).toEqual([]);
  });
});

describe("applyPointsRules", () => {
  it("splits a question the AI left whole into the parts and points asked for", () => {
    const items = [item({ label: "2", pointsCenti: 100 }), item({ label: "3", prompt: "Solve for x.", expectedAnswer: "x = 4", pointsCenti: 100 })];
    const { items: out, notes } = applyPointsRules(items, "Question 3: 2 points for setting up the equation, 2 for the work, 1 for the final answer.");
    expect(out.map((i) => [i.label, i.groupLabel, i.pointsCenti])).toEqual([["2", "", 100], ["3a", "3", 200], ["3b", "3", 200], ["3c", "3", 100]]);
    expect(out[1]).toMatchObject({ prompt: "Solve for x. (part a: setting up the equation)", expectedAnswer: "x = 4", partialCredit: true });
    expect(out[1].gradingCriteria).toContain("Grade only this part of question 3 (part a: setting up the equation).");
    expect(notes).toEqual(["Split question 3 into 3 parts with your points, as your instructions say."]);
  });

  it("splits a total evenly when only the number of parts is given", () => {
    const { items: out } = applyPointsRules([item({ label: "1", pointsCenti: 100 })], "Question 1 is worth 10 points, split into 3 parts");
    expect(out.map((i) => [i.label, i.pointsCenti])).toEqual([["1a", 334], ["1b", 333], ["1c", 333]]);
  });

  it("re-points parts the AI already split, and leaves a mismatch to the teacher", () => {
    const parts = [item({ label: "3a", groupLabel: "3", pointsCenti: 100 }), item({ label: "3b", groupLabel: "3", pointsCenti: 100 })];
    expect(applyPointsRules(parts, "Question 3 is worth 6 points").items.map((i) => i.pointsCenti)).toEqual([300, 300]);
    const mismatch = applyPointsRules(parts, "Question 3 has 4 parts worth 1 point each");
    expect(mismatch.items).toEqual(parts);
    expect(mismatch.notes).toEqual(["Your instructions split question 3 into 4 parts, but the key shows 2. Check its parts and points."]);
  });

  it("sets a single question's points and notes questions the key doesn't have", () => {
    const { items: out, notes } = applyPointsRules([item({ label: "5", pointsCenti: 100 })], "Question 5 is worth 8 points. Question 9 is worth 2 points.");
    expect(out[0].pointsCenti).toBe(800);
    expect(notes).toEqual([
      "Set the points for question 5 from your instructions.",
      "Your instructions give points for question 9, but the key has no question 9.",
    ]);
  });
});
