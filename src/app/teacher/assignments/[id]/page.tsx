import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { Board } from "@/components/teacher/board";
import { BoardFilters } from "@/components/teacher/board-filters";
import { boardHref, boardRefreshMs, firstNeedsReviewId, parseBoardFilter, reviewHref } from "@/components/teacher/board-helpers";
import { BulkActions } from "@/components/teacher/bulk-actions";
import { plural } from "@/components/teacher/text";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { getBoardView } from "@/lib/services/views";
import type { AssignmentStatus, BoardView } from "@/lib/types";

const NO_PAPERS_HINT: Record<AssignmentStatus, string> = {
  draft: "Open the assignment, then share the code or link. Papers appear here as students hand them in, grouped by section.",
  open: "Share the code or link with your students. Papers appear here as they arrive, grouped by section.",
  closed: "This assignment is closed, so students can't hand anything in. You can still upload scanned paper copies.",
};

export default async function SubmissionsPage(props: PageProps<"/teacher/assignments/[id]">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const filter = parseBoardFilter((await props.searchParams).filter);
  const view = getBoardView(assignment, filter);
  const uploadHref = `/teacher/assignments/${assignment.id}/upload`;

  return (
    <div className="flex flex-col gap-5">
      <ReviewCallout assignmentId={assignment.id} groups={view.groups} />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <BoardFilters assignmentId={assignment.id} filter={filter} counts={view.counts} />
        <BulkActions
          assignmentId={assignment.id}
          staleCount={view.staleCount}
          failedCount={view.counts.failed}
          hasPapers={view.counts.total > 0}
        />
      </div>

      {view.counts.total === 0 ? (
        <EmptyState
          title="No papers yet"
          body={NO_PAPERS_HINT[assignment.status]}
          action={<LinkButton href={uploadHref} variant="secondary">Upload scanned papers</LinkButton>}
        />
      ) : view.groups.length === 0 ? (
        <EmptyState
          title="No papers match this filter"
          action={<LinkButton href={boardHref(assignment.id, "all")} variant="secondary">Show all papers</LinkButton>}
        />
      ) : (
        <Board assignmentId={assignment.id} groups={view.groups} />
      )}

      <AutoRefresh intervalMs={boardRefreshMs(view)} />
    </div>
  );
}

/** The board's main call to action: how many papers wait for the teacher, and a button to start on the first. */
function ReviewCallout({ assignmentId, groups }: { assignmentId: string; groups: BoardView["groups"] }) {
  const firstId = firstNeedsReviewId(groups);
  if (!firstId) return null;
  const count = groups.flatMap((group) => group.rows).filter((row) => row.status === "needs_review").length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-200 bg-warning-50 px-4 py-3">
      <p className="font-medium text-warning-800">
        {plural(count, "paper")} {count === 1 ? "needs" : "need"} your review before {count === 1 ? "its" : "their"} grade
        can be released.
      </p>
      <LinkButton href={reviewHref(assignmentId, firstId)}>Start reviewing</LinkButton>
    </div>
  );
}
