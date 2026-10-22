import { describe, expect, it } from "vitest";
import { judgmentSourceText } from "./judgment-source";

describe("judgmentSourceText", () => {
  it("says who decided the item", () => {
    expect(judgmentSourceText({ judgedBy: "program", correctness: "correct" })).toBe("Marked by the program (exact match)");
    expect(judgmentSourceText({ judgedBy: "program", correctness: "incorrect" })).toBe("Marked by the program (doesn't match the key)");
    expect(judgmentSourceText({ judgedBy: "program", correctness: "no_answer" })).toBe("Marked by the program (left blank)");
    expect(judgmentSourceText({ judgedBy: "program", correctness: "cannot_judge" })).toBe("Marked by the program (couldn't be read)");
    expect(judgmentSourceText({ judgedBy: "ai", correctness: "partially_correct" })).toBe("Judged by the AI");
  });

  it("says nothing for gradings stored before it was recorded", () => {
    expect(judgmentSourceText({ correctness: "correct" })).toBeNull();
  });
});
