import { connection } from "next/server";
import { Board } from "@/components/teacher/board";
import { BoardFilters } from "@/components/teacher/board-filters";
import { boardHref, firstNeedsReviewId, parseBoardFilter, reviewHref } from "@/components/teacher/board-helpers";
import { BulkActions } from "@/components/teacher/bulk-actions";
import { MatchingAnswersCard } from "@/components/teacher/matching-answers";
import { MissedQuestionsCard } from "@/components/teacher/question-stats";
import { parseMissedParam, questionName, shortPrompt } from "@/components/teacher/question-text";
import { plural } from "@/components/teacher/text";
import { LiveWorkspace } from "@/components/teacher/workspace/live-workspace";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { loadAssignmentLive } from "@/lib/services/live";
import { onePassAvailable } from "@/lib/services/scans";
import { getAnswerMatches, getBoardView, getItemStats, getUploadPageView } from "@/lib/services/views";
import type { BoardView } from "@/lib/types";

/**
 * The assignment's workspace: answer key → students' work → grading, live (see LiveWorkspace), then the results board, the
 * questions most students got wrong and, on a quiz, students with matching wrong answers.
 */
export default async function WorkspacePage(props: PageProps<"/teacher/assignments/[id]">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const searchParams = await props.searchParams;
  const filter = parseBoardFilter(searchParams.filter);
  const view = getBoardView(assignment, filter, parseMissedParam(searchParams.missed));
  const itemStats = getItemStats(assignment);
  // Quizzes only: on homework students may work together, and most answers match.
  const matches = view.counts.total > 0 ? getAnswerMatches(assignment) : null;
  const live = loadAssignmentLive(assignment);
  const { keyPageCount } = getUploadPageView(assignment);

  return (
    <div className="flex flex-col gap-5">
      <LiveWorkspace initial={live} keyPageCount={keyPageCount} onePassAvailable={onePassAvailable(assignment.id)} />

      {view.counts.total > 0 && (
        <section aria-labelledby="results-heading" className="flex flex-col gap-5">
          <h2 id="results-heading" className="text-xl font-semibold">Results</h2>
          <ReviewCallout assignmentId={assignment.id} groups={view.groups} />

          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            {/* While the board shows one question's misses, no status chip is current; any chip clears that filter. */}
            <BoardFilters assignmentId={assignment.id} filter={view.missed ? null : filter} counts={view.counts} />
            <BulkActions
              assignmentId={assignment.id}
              staleCount={view.staleCount}
              guidanceStaleCount={view.guidanceStaleCount}
              spotsStaleCount={view.spotsStaleCount}
              failedCount={view.counts.failed}
              hasPapers={view.counts.total > 0}
              project={assignment.kind === "project"}
            />
          </div>

          {view.missed && <MissedFilterBanner assignmentId={assignment.id} missed={view.missed} />}

          {view.groups.length === 0 ? (
            <EmptyState
              title={view.missed ? `No graded paper missed ${questionName(view.missed.label)}` : "No papers match this filter"}
              action={<LinkButton href={boardHref(assignment.id, "all")} variant="secondary">Show all papers</LinkButton>}
            />
          ) : (
            <Board assignmentId={assignment.id} groups={view.groups} />
          )}
        </section>
      )}

      <MissedQuestionsCard assignmentId={assignment.id} stats={itemStats} activeItemId={view.missed?.itemId ?? null} />

      {matches && <MatchingAnswersCard assignmentId={assignment.id} summary={matches} />}
    </div>
  );
}

/** Above the board while it shows one question's misses: which question, its most common answers, and the way back. */
function MissedFilterBanner({ assignmentId, missed }: { assignmentId: string; missed: NonNullable<BoardView["missed"]> }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-info-200 bg-info-50 px-4 py-3 text-info-800">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="font-medium">
          Showing the {missed.count === 1 ? "paper" : `${missed.count} papers`} that missed {questionName(missed.label)}, with what
          each student wrote.
        </p>
        <LinkButton href={boardHref(assignmentId, "all")} variant="secondary" size="sm">
          Show all papers
        </LinkButton>
      </div>
      {missed.prompt.trim() !== "" && <p className="line-clamp-2 text-sm">{shortPrompt(missed.prompt)}</p>}
      {missed.commonAnswers.length > 0 && (
        <p className="text-sm">
          <span className="font-medium">Common answers:</span>{" "}
          {missed.commonAnswers.map((entry, i) => (
            <span key={entry.answer}>
              {i > 0 && " · "}
              <span className="break-words">“{entry.answer}”</span> ({plural(entry.count, "paper")})
            </span>
          ))}
        </p>
      )}
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
        The AI flagged {plural(count, "paper")} for you to check before you record {count === 1 ? "its grade" : "their grades"}.
      </p>
      <LinkButton href={reviewHref(assignmentId, firstId)}>Check the first one</LinkButton>
    </div>
  );
}
