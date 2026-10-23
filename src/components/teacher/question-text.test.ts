import { describe, expect, it } from "vitest";
import type { ItemTally } from "@/lib/grading/item-stats";
import { missedHref, missedLine, parseMissedParam, shortPrompt, strugglingLine } from "./question-text";

const TALLY: ItemTally = {
  judged: 8, correct: 3, partly: 1, wrong: 3, blank: 1, unreadable: 0, missedPapers: 5, earnedCenti: 0, maxCenti: 0,
  earnedTenths: null, correctTenths: 375, missedTenths: 594,
};

describe("question text", () => {
  it("describes how a question was missed", () => {
    expect(missedLine("3", TALLY)).toBe("Question 3 — 59.4% missed (5 of 8 students: 3 wrong, 1 blank, 1 partly right)");
    expect(missedLine("2a", { ...TALLY, unreadable: 2, missedPapers: 7 })).toBe(
      "Question 2a — 59.4% missed (7 of 8 students: 3 wrong, 1 blank, 1 partly right, 2 unreadable)",
    );
  });

  it("says how many students missed a question, for the dashboard", () => {
    expect(strugglingLine({ missedTenths: 714, missedPapers: 5, judged: 7 })).toBe("71.4% missed (5 of 7 students)");
    expect(strugglingLine({ missedTenths: 1000, missedPapers: 1, judged: 1 })).toBe("100% missed (1 of 1 student)");
  });

  it("shortens long prompts", () => {
    expect(shortPrompt("  Solve\n for   x.  ")).toBe("Solve for x.");
    expect(shortPrompt("abcdefghij", 4)).toBe("abcd…");
    expect(shortPrompt("abcd", 4)).toBe("abcd");
  });

  it("builds and reads the missed filter", () => {
    expect(missedHref("a1", "i 1")).toBe("/teacher/assignments/a1?missed=i%201");
    expect(parseMissedParam("item")).toBe("item");
    expect(parseMissedParam(["a", "b"])).toBeNull();
    expect(parseMissedParam("")).toBeNull();
    expect(parseMissedParam(undefined)).toBeNull();
  });
});
