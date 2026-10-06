import { describe, expect, it } from "vitest";
import { formatPercent, formatPoints, formatShareCode, parsePointsInput } from "@/lib/format";

describe("formatPoints", () => {
  it.each([
    [750, "7.5"],
    [1000, "10"],
    [0, "0"],
    [5, "0.05"],
    [50, "0.5"],
    [1234, "12.34"],
    [1005, "10.05"],
    [100000, "1000"],
    [null, "—"],
  ])("%j → %j", (centi, expected) => {
    expect(formatPoints(centi)).toBe(expected);
  });
});

describe("formatPercent", () => {
  it.each([
    [875, "87.5%"],
    [1000, "100%"],
    [0, "0%"],
    [1, "0.1%"],
    [333, "33.3%"],
    [null, "—"],
  ])("%j → %j", (tenths, expected) => {
    expect(formatPercent(tenths)).toBe(expected);
  });
});

describe("parsePointsInput", () => {
  it.each([
    ["7.5", 750],
    ["7.50", 750],
    ["7.05", 705],
    ["10", 1000],
    ["0", 0],
    ["0.29", 29],
    [".5", 50],
    ["7.", 700],
    [" 3 ", 300],
    ["1000", 100000],
  ])("%j → %j", (input, expected) => {
    expect(parsePointsInput(input)).toBe(expected);
  });

  it.each(["", "   "])("%j → null", (input) => {
    expect(parsePointsInput(input)).toBeNull();
  });

  it.each([".", "-1", "7.555", "abc", "7,5", "1e3", "7.5pt", "+3", "1.2.3"])("%j → NaN", (input) => {
    expect(parsePointsInput(input)).toBeNaN();
  });

  it("round-trips with formatPoints", () => {
    for (const centi of [0, 1, 29, 50, 705, 750, 1000, 12345]) {
      expect(parsePointsInput(formatPoints(centi))).toBe(centi);
    }
  });
});

describe("formatShareCode", () => {
  it("shows the code as typed on the share card", () => {
    expect(formatShareCode("K7M4QX")).toBe("K7M4QX");
  });
});
