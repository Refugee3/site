import type { BoardFilter, BoardView, StatusCounts } from "@/lib/types";

/** The board's filters in display order, with how many papers each one shows. */
export const BOARD_FILTERS: ReadonlyArray<{ filter: BoardFilter; label: string; count: (c: StatusCounts) => number }> = [
  { filter: "all", label: "All", count: (c) => c.total },
  { filter: "needs_review", label: "Needs review", count: (c) => c.needs_review },
  { filter: "in_progress", label: "In progress", count: (c) => c.queued + c.grading },
  { filter: "failed", label: "Failed", count: (c) => c.failed },
  { filter: "graded", label: "Graded", count: (c) => c.graded },
];

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

/** §7: quick polling while papers are being graded, slow while students can still submit, else none. */
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
