import { describe, expect, it } from "vitest";
import { charLength, truncateChars } from "@/lib/grading/text";

describe("text helpers", () => {
  it("counts characters, not UTF-16 code units", () => {
    expect(charLength("abc")).toBe(3);
    expect(charLength("😀é")).toBe(2);
  });

  it("truncates without splitting surrogate pairs", () => {
    expect(truncateChars("😀😀😀", 2)).toBe("😀😀");
    expect(truncateChars("short", 10)).toBe("short");
    expect(truncateChars("", 0)).toBe("");
  });
});
