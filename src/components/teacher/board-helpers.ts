import { boardFilterCount } from "@/lib/grading/board";
import type { BoardFilter, BoardView, StatusCounts } from "@/lib/types";

/** The board's filters in display order, with how many papers each one shows (the same rule as the rows). */
export const BOARD_FILTERS: ReadonlyArray<{ filter: BoardFilter; label: string; count: (c: StatusCounts) => number }> = (
  [
    ["all", "All"],
    ["needs_review", "Needs review"],
    ["in_progress", "In progress"],
    ["failed", "Failed"],
    ["graded", "Graded"],
  ] as const
).map(([filter, label]) => ({ filter, label, count: (c: StatusCounts) => boardFilterCount(filter, c) }));

/** `?filter=` from the URL; anything unknown (or repeated) shows everything. */
export function parseBoardFilter(value: string | string[] | undefined): BoardFilter {
  return BOARD_FILTERS.find((f) => f.filter === value)?.filter ?? "all";
}

export function boardHref(assignmentId: string, filter: BoardFilter): string {
  const base = `/teacher/assignments/${assignmentId}`;
  return filter === "all" ? base : `${base}?filter=${filter}`;
}

export function reviewHref(assignmentId: string, submissionId: string): string {
  return `/teacher/assignments/${assignmentId}/submissions/${submissionId}`;
}

const ACTIVE_POLL_MS = 4000;
const OPEN_POLL_MS = 15_000;

/** Quick polling while papers are being graded, slow while students can still submit, else none. */
export function boardRefreshMs(view: Pick<BoardView, "active" | "open">): number | null {
  if (view.active) return ACTIVE_POLL_MS;
  return view.open ? OPEN_POLL_MS : null;
}

/** The first current paper in board order that needs review, if the board shows one. */
export function firstNeedsReviewId(groups: BoardView["groups"]): string | null {
  for (const group of groups) {
    const row = group.rows.find((r) => r.status === "needs_review");
    if (row) return row.submissionId;
  }
  return null;
}
