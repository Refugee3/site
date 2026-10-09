import { describe, expect, it } from "vitest";
import type { BoardRow, BoardView, StatusCounts } from "@/lib/types";
import { BOARD_FILTERS, boardHref, boardRefreshMs, firstNeedsReviewId, parseBoardFilter, reviewHref } from "./board-helpers";

function row(submissionId: string, status: BoardRow["status"]): BoardRow {
  return {
    submissionId, displayName: submissionId, status, statusNote: null, source: "student", scoreEarnedCenti: null,
    scoreMaxCenti: null, percentTenths: null, flags: [], stale: false, earlier: [], pageCount: 1, createdAt: 0,
  };
}

describe("parseBoardFilter", () => {
  it("accepts every known filter", () => {
    for (const { filter } of BOARD_FILTERS) expect(parseBoardFilter(filter)).toBe(filter);
  });

  it("falls back to all for missing, unknown or repeated values", () => {
    expect(parseBoardFilter(undefined)).toBe("all");
    expect(parseBoardFilter("NEEDS_REVIEW")).toBe("all");
    expect(parseBoardFilter("toString")).toBe("all");
    expect(parseBoardFilter(["failed", "graded"])).toBe("all");
  });
});

describe("filter counts", () => {
  it("counts in-progress papers as queued plus grading", () => {
    const counts: StatusCounts = { queued: 2, grading: 1, graded: 5, needs_review: 3, failed: 1, total: 12 };
    const byFilter = Object.fromEntries(BOARD_FILTERS.map((f) => [f.filter, f.count(counts)]));
    expect(byFilter).toEqual({ all: 12, needs_review: 3, in_progress: 3, failed: 1, graded: 5 });
  });
});

describe("links", () => {
  it("omits the query for the all filter", () => {
    expect(boardHref("a1", "all")).toBe("/teacher/assignments/a1");
    expect(boardHref("a1", "needs_review")).toBe("/teacher/assignments/a1?filter=needs_review");
    expect(reviewHref("a1", "s1")).toBe("/teacher/assignments/a1/submissions/s1");
  });
});

describe("boardRefreshMs", () => {
  it("polls every 4 s while grading, every 15 s while open, otherwise not at all", () => {
    expect(boardRefreshMs({ active: true, open: true })).toBe(4000);
    expect(boardRefreshMs({ active: true, open: false })).toBe(4000);
    expect(boardRefreshMs({ active: false, open: true })).toBe(15000);
    expect(boardRefreshMs({ active: false, open: false })).toBeNull();
  });
});

describe("firstNeedsReviewId", () => {
  it("walks groups in board order", () => {
    const groups: BoardView["groups"] = [
      { key: "p1", label: "Period 1", rows: [row("a", "graded"), row("b", "queued")] },
      { key: "p3", label: "Period 3", rows: [row("c", "graded"), row("d", "needs_review"), row("e", "needs_review")] },
      { key: "none", label: "No section", rows: [row("f", "needs_review")] },
    ];
    expect(firstNeedsReviewId(groups)).toBe("d");
  });

  it("returns null when nothing shown needs review", () => {
    expect(firstNeedsReviewId([{ key: "none", label: "No section", rows: [row("a", "graded")] }])).toBeNull();
    expect(firstNeedsReviewId([])).toBeNull();
  });
});
