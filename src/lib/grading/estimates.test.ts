import { describe, expect, it } from "vitest";
import {
  estimateBatchEtaMs, estimateSplitEtaMs, FALLBACK_EXTRACTION_MS, FALLBACK_PAPER_MS, FALLBACK_SCAN_PAGE_MS, median, typicalMs,
} from "@/lib/grading/estimates";

describe("median", () => {
  it("is the middle value, or the mean of the middle two", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
    expect(median([7])).toBe(7);
  });

  it("is null for no usable values, ignoring negative and non-finite ones", () => {
    expect(median([])).toBeNull();
    expect(median([-5, Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
    expect(median([-5, 10])).toBe(10);
  });
});

describe("typicalMs", () => {
  it("prefers this assignment's durations, then every assignment's, then the fallback", () => {
    expect(typicalMs([50_000, 70_000, 90_000], [1_000], FALLBACK_PAPER_MS)).toBe(70_000);
    expect(typicalMs([], [1_000, 3_000], FALLBACK_PAPER_MS)).toBe(2_000);
    expect(typicalMs([], [], FALLBACK_PAPER_MS)).toBe(60_000);
    expect(FALLBACK_EXTRACTION_MS).toBe(45_000);
    expect(FALLBACK_SCAN_PAGE_MS).toBe(2_000);
  });

  it("looks at the 20 newest durations only (lists are newest first), in whole ms", () => {
    const newest = new Array<number>(20).fill(10_000);
    expect(typicalMs([...newest, 900_000, 900_000, 900_000], [], FALLBACK_PAPER_MS)).toBe(10_000);
    expect(typicalMs([1_000.4, 1_000.8], [], FALLBACK_PAPER_MS)).toBe(1_001);
  });
});

describe("estimateBatchEtaMs", () => {
  it("is ceil(queued / concurrency) × typical with nothing in flight", () => {
    expect(estimateBatchEtaMs({ queued: 25, inFlightElapsedMs: [], concurrency: 10, typicalMs: 60_000 })).toBe(180_000);
    expect(estimateBatchEtaMs({ queued: 10, inFlightElapsedMs: [], concurrency: 10, typicalMs: 60_000 })).toBe(60_000);
    expect(estimateBatchEtaMs({ queued: 3, inFlightElapsedMs: [], concurrency: 1, typicalMs: 1_000 })).toBe(3_000);
  });

  it("counts what the papers in flight still need, and is 0 with nothing left", () => {
    expect(estimateBatchEtaMs({ queued: 0, inFlightElapsedMs: [], concurrency: 4, typicalMs: 60_000 })).toBe(0);
    expect(estimateBatchEtaMs({ queued: 0, inFlightElapsedMs: [20_000, 50_000], concurrency: 4, typicalMs: 60_000 })).toBe(40_000);
    // Two slots: one frees at 10 s, one at 40 s; the queued paper takes the first (10 s + 60 s).
    expect(estimateBatchEtaMs({ queued: 1, inFlightElapsedMs: [50_000, 20_000], concurrency: 2, typicalMs: 60_000 })).toBe(70_000);
    // A paper running longer than typical counts as finishing now.
    expect(estimateBatchEtaMs({ queued: 0, inFlightElapsedMs: [90_000], concurrency: 2, typicalMs: 60_000 })).toBe(0);
  });

  it("only shrinks as time passes", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let elapsed = 0; elapsed <= 120_000; elapsed += 5_000) {
      const eta = estimateBatchEtaMs({ queued: 7, inFlightElapsedMs: [elapsed, elapsed + 10_000, elapsed + 30_000], concurrency: 3, typicalMs: 60_000 });
      expect(eta).toBeLessThanOrEqual(previous);
      previous = eta;
    }
  });

  it("copes with more papers in flight than the (just lowered) concurrency, and a concurrency below one", () => {
    expect(estimateBatchEtaMs({ queued: 1, inFlightElapsedMs: [0, 0, 0, 0], concurrency: 2, typicalMs: 1_000 })).toBe(2_000);
    expect(estimateBatchEtaMs({ queued: 2, inFlightElapsedMs: [], concurrency: 0, typicalMs: 1_000 })).toBe(2_000);
  });
});

describe("estimateSplitEtaMs", () => {
  it("is the expected total minus the time since the split was queued, never below 0", () => {
    expect(estimateSplitEtaMs({ pageCount: 60, elapsedMs: 0, perPageMs: 2_000 })).toBe(120_000);
    expect(estimateSplitEtaMs({ pageCount: 60, elapsedMs: 30_000, perPageMs: 2_000 })).toBe(90_000);
    expect(estimateSplitEtaMs({ pageCount: 60, elapsedMs: 500_000, perPageMs: 2_000 })).toBe(0);
    expect(estimateSplitEtaMs({ pageCount: 3, elapsedMs: -10, perPageMs: 1_000.4 })).toBe(3_001);
  });
});
