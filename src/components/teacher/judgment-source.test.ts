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

describe("judgmentSourceText with mark detection", () => {
  const choice = { kind: "choice" as const, page: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, map: { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 } };
  it("says the marks decided it", () => {
    expect(judgmentSourceText({ judgedBy: "program", correctness: "correct", spot: choice })).toBe("Marked by mark detection (matches the key)");
    expect(judgmentSourceText({ judgedBy: "program", correctness: "incorrect", spot: choice })).toBe("Marked by mark detection (doesn't match the key)");
    expect(judgmentSourceText({ judgedBy: "program", correctness: "no_answer", spot: choice })).toBe("Marked by mark detection (nothing marked)");
    expect(judgmentSourceText({ judgedBy: "program", correctness: "no_answer", spot: { ...choice, kind: "write_in" } }))
      .toBe("Marked by mark detection (answer spot empty)");
    expect(judgmentSourceText({ judgedBy: "ai", correctness: "correct", spot: { ...choice, kind: "write_in" } }))
      .toBe("Read from the answer spot's crop; judged by the AI");
  });
});
