import { describe, expect, it } from "vitest";
import {
  batchFraction, ESTIMATE_CAP, estimatedFraction, formatApproxDuration, formatClock, formatTimeLeft, remainingMs, secondsUntil,
  upperFirst,
} from "./time-estimates";

describe("formatClock", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [1000, "0:01"],
    [59_999, "0:59"],
    [60_000, "1:00"],
    [83_000, "1:23"],
    [10 * 60_000 + 5000, "10:05"],
    [59 * 60_000 + 59_000, "59:59"],
    [3_600_000, "1:00:00"],
    [3_723_000, "1:02:03"],
    [26 * 3_600_000, "26:00:00"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });

  it("never shows a negative or broken time", () => {
    expect(formatClock(-5000)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});

describe("formatTimeLeft", () => {
  it.each([
    [0, "finishing up…"],
    [-1000, "finishing up…"],
    [Number.NaN, "finishing up…"],
    [1, "less than a minute left"],
    [59_999, "less than a minute left"],
    [60_000, "about 1 min left"],
    [89_000, "about 1 min left"],
    [90_000, "about 2 min left"],
    [5 * 60_000, "about 5 min left"],
    [59 * 60_000, "about 59 min left"],
    [60 * 60_000, "about 1 h left"],
    [80 * 60_000, "about 1 h 20 min left"],
    [125 * 60_000, "about 2 h 5 min left"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatTimeLeft(ms)).toBe(text);
  });
});

describe("formatApproxDuration", () => {
  it.each([
    [0, "1 second"],
    [400, "1 second"],
    [1499, "1 second"],
    [1500, "2 seconds"],
    [45_000, "45 seconds"],
    [59_400, "59 seconds"],
    [59_600, "1 minute"],
    [60_000, "1 minute"],
    [89_000, "1 minute"],
    [90_000, "2 minutes"],
    [45 * 60_000, "45 minutes"],
    [60 * 60_000, "1 h"],
    [80 * 60_000, "1 h 20 min"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatApproxDuration(ms)).toBe(text);
  });

  it("treats a negative or broken duration as the shortest", () => {
    expect(formatApproxDuration(-1)).toBe("1 second");
    expect(formatApproxDuration(Number.NaN)).toBe("1 second");
  });
});

describe("upperFirst", () => {
  it("capitalizes the first letter only", () => {
    expect(upperFirst("about 3 min left")).toBe("About 3 min left");
    expect(upperFirst("")).toBe("");
  });
});

describe("estimatedFraction", () => {
  it("is elapsed ÷ typical", () => {
    expect(estimatedFraction(0, 60_000)).toBe(0);
    expect(estimatedFraction(15_000, 60_000)).toBe(0.25);
    expect(estimatedFraction(30_000, 60_000)).toBe(0.5);
  });

  it("holds at 95% until the work is done, however long it runs", () => {
    expect(ESTIMATE_CAP).toBe(0.95);
    expect(estimatedFraction(57_000, 60_000)).toBeCloseTo(0.95, 10);
    expect(estimatedFraction(60_000, 60_000)).toBe(0.95);
    expect(estimatedFraction(10 * 60_000, 60_000)).toBe(0.95);
  });

  it("takes another cap", () => {
    expect(estimatedFraction(90_000, 60_000, 1)).toBe(1);
    expect(estimatedFraction(30_000, 60_000, 0.4)).toBe(0.4);
  });

  it("never goes below 0 or breaks on a missing typical time", () => {
    expect(estimatedFraction(-5000, 60_000)).toBe(0);
    expect(estimatedFraction(5000, 0)).toBe(0);
    expect(estimatedFraction(5000, Number.NaN)).toBe(0);
    expect(estimatedFraction(Number.NaN, 60_000)).toBe(0);
  });
});

describe("batchFraction", () => {
  const base = { done: 0, total: 10, grading: 0, inFlightElapsedMs: 0, typicalPaperMs: 60_000 };

  it("is done ÷ total with nothing in flight", () => {
    expect(batchFraction(base)).toBe(0);
    expect(batchFraction({ ...base, done: 3 })).toBeCloseTo(0.3, 10);
    expect(batchFraction({ ...base, done: 10 })).toBe(1);
  });

  it("gives the papers being graded partial credit by elapsed ÷ typical", () => {
    // One paper halfway through: 3.5 of 10.
    expect(batchFraction({ ...base, done: 3, grading: 1, inFlightElapsedMs: 30_000 })).toBeCloseTo(0.35, 10);
    // Two papers a quarter of the way through: half a paper of credit.
    expect(batchFraction({ ...base, done: 3, grading: 2, inFlightElapsedMs: 15_000 })).toBeCloseTo(0.35, 10);
  });

  it("never credits as much as the next whole paper", () => {
    // Ten papers halfway through would be five papers; the bar stops just short of the next one instead.
    expect(batchFraction({ ...base, done: 0, grading: 10, inFlightElapsedMs: 30_000 })).toBeCloseTo(0.095, 10);
    // A paper running long stays just short of done + 1.
    expect(batchFraction({ ...base, done: 3, grading: 1, inFlightElapsedMs: 10 * 60_000 })).toBeCloseTo(0.395, 10);
    expect(batchFraction({ ...base, done: 3, grading: 1, inFlightElapsedMs: 10 * 60_000 })).toBeLessThan(0.4);
  });

  it("stays within 0..1 for odd counts", () => {
    expect(batchFraction({ ...base, total: 0 })).toBe(0);
    expect(batchFraction({ ...base, done: 12 })).toBe(1);
    expect(batchFraction({ ...base, done: -1 })).toBe(0);
    // More in flight than papers left: only the papers left get credit.
    expect(batchFraction({ ...base, done: 9, grading: 5, inFlightElapsedMs: 30_000 })).toBeCloseTo(0.95, 10);
    expect(batchFraction({ ...base, done: 2, grading: 1, inFlightElapsedMs: -5000 })).toBeCloseTo(0.2, 10);
  });
});

describe("remainingMs", () => {
  it("counts the server's estimate down by the time since the page was rendered", () => {
    expect(remainingMs(120_000, 0)).toBe(120_000);
    expect(remainingMs(120_000, 30_000)).toBe(90_000);
  });

  it("never goes negative, and ignores a clock that went backwards", () => {
    expect(remainingMs(10_000, 30_000)).toBe(0);
    expect(remainingMs(10_000, -5000)).toBe(10_000);
  });
});

describe("secondsUntil", () => {
  it("rounds up to whole seconds", () => {
    expect(secondsUntil(10_000, 0)).toBe(10);
    expect(secondsUntil(10_000, 500)).toBe(10);
    expect(secondsUntil(10_000, 9001)).toBe(1);
  });

  it("is 0 once passed, or without a time", () => {
    expect(secondsUntil(10_000, 10_000)).toBe(0);
    expect(secondsUntil(10_000, 20_000)).toBe(0);
    expect(secondsUntil(null, 0)).toBe(0);
  });
});
