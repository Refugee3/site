import { boardFilterCount } from "@/lib/grading/board";
import type { BoardFilter, BoardView, StatusCounts } from "@/lib/types";

/** The board's filters in display order, with how many papers each one shows (the same rule as the rows). */
export const BOARD_FILTERS: ReadonlyArray<{ filter: BoardFilter; label: string; count: (c: StatusCounts) => number }> = (
  [
    ["all", "All"],
    ["needs_review", "Needs your check"],
    ["in_progress", "Being graded"],
    ["failed", "Couldn't be graded"],
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

/** Quick polling while papers are being graded (or a scan split), else none: only the teacher adds papers. */
export function boardRefreshMs(view: Pick<BoardView, "active">): number | null {
  return view.active ? ACTIVE_POLL_MS : null;
}

/** The first current paper in board order that needs review, if the board shows one. */
export function firstNeedsReviewId(groups: BoardView["groups"]): string | null {
  for (const group of groups) {
    const row = group.rows.find((r) => r.status === "needs_review");
    if (row) return row.submissionId;
  }
  return null;
}
