import { describe, expect, it } from "vitest";
import { parsePointsOverride, pointsInputText } from "./points";

describe("parsePointsOverride", () => {
  it("treats blank as clearing the override", () => {
    expect(parsePointsOverride("", 200)).toEqual({ ok: true, centi: null });
    expect(parsePointsOverride("   ", 200)).toEqual({ ok: true, centi: null });
  });

  it("parses points into centipoints, including zero and the maximum", () => {
    expect(parsePointsOverride("1.5", 200)).toEqual({ ok: true, centi: 150 });
    expect(parsePointsOverride("0", 200)).toEqual({ ok: true, centi: 0 });
    expect(parsePointsOverride("2", 200)).toEqual({ ok: true, centi: 200 });
  });

  it("rejects malformed numbers and values above the maximum", () => {
    expect(parsePointsOverride("abc", 200).ok).toBe(false);
    expect(parsePointsOverride("-1", 200).ok).toBe(false);
    expect(parsePointsOverride("1.255", 200).ok).toBe(false);
    expect(parsePointsOverride("2.01", 200)).toEqual({ ok: false, error: "Enter at most 2 points." });
  });
});

describe("pointsInputText", () => {
  it("is empty without an override", () => {
    expect(pointsInputText(null)).toBe("");
    expect(pointsInputText(0)).toBe("0");
    expect(pointsInputText(750)).toBe("7.5");
  });
});
