import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { Board } from "@/components/teacher/board";
import { BoardFilters } from "@/components/teacher/board-filters";
import { boardHref, boardRefreshMs, firstNeedsReviewId, parseBoardFilter, reviewHref } from "@/components/teacher/board-helpers";
import { BulkActions } from "@/components/teacher/bulk-actions";
import { GradingProgressCard } from "@/components/teacher/progress-widgets";
import { MissedQuestionsCard } from "@/components/teacher/question-stats";
import { parseMissedParam, questionName, shortPrompt } from "@/components/teacher/question-text";
import { plural } from "@/components/teacher/text";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { now } from "@/lib/clock";
import { getWorkerStatus } from "@/lib/jobs/queue";
import { getBoardView, getItemStats } from "@/lib/services/views";
import { kindNoun, uploadLabel } from "@/lib/format";
import type { AssignmentKind, AssignmentStatus, BoardView } from "@/lib/types";

const NO_PAPERS_HINT: Record<AssignmentStatus, string> = {
  draft: "Open the assignment, then share the code or link. Papers appear here as students hand them in, grouped by section.",
  open: "Share the code or link with your students. Papers appear here as they arrive, grouped by section.",
  closed: "This assignment is closed, so students can't hand anything in. You can still upload scanned paper copies.",
};

export default async function SubmissionsPage(props: PageProps<"/teacher/assignments/[id]">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const searchParams = await props.searchParams;
  const filter = parseBoardFilter(searchParams.filter);
  const view = getBoardView(assignment, filter, parseMissedParam(searchParams.missed));
  const itemStats = getItemStats(assignment);
  const worker = view.progress ? getWorkerStatus() : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Gone on the first refresh after the batch's last paper is done. */}
      {view.progress && (
        <GradingProgressCard
          progress={view.progress}
          serverNow={now()}
          throttledUntil={worker?.throttledUntil ?? null}
          halted={worker === null || worker.state !== "running"}
        />
      )}
      <ScanCallout assignmentId={assignment.id} kind={assignment.kind} scans={view.scans} />
      <ReviewCallout assignmentId={assignment.id} groups={view.groups} />
      <MissedQuestionsCard assignmentId={assignment.id} stats={itemStats} activeItemId={view.missed?.itemId ?? null} />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        {/* While the board shows one question's misses, no status chip is current; any chip clears that filter. */}
        <BoardFilters assignmentId={assignment.id} filter={view.missed ? null : filter} counts={view.counts} />
        <BulkActions
          assignmentId={assignment.id}
          staleCount={view.staleCount}
          guidanceStaleCount={view.guidanceStaleCount}
          failedCount={view.counts.failed}
          hasPapers={view.counts.total > 0}
        />
      </div>

      {view.missed && <MissedFilterBanner assignmentId={assignment.id} missed={view.missed} />}

      {view.counts.total === 0 ? (
        <NoPapers assignmentId={assignment.id} kind={assignment.kind} status={assignment.status} studentsCanUpload={view.studentsCanUpload} />
      ) : view.groups.length === 0 ? (
        <EmptyState
          title={view.missed ? `No graded paper missed ${questionName(view.missed.label)}` : "No papers match this filter"}
          action={<LinkButton href={boardHref(assignment.id, "all")} variant="secondary">Show all papers</LinkButton>}
        />
      ) : (
        <Board assignmentId={assignment.id} groups={view.groups} />
      )}

      <AutoRefresh intervalMs={boardRefreshMs(view)} />
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

/** While students can't upload, the teacher uploads every paper, so the empty board points there first. */
function NoPapers(props: { assignmentId: string; kind: AssignmentKind; status: AssignmentStatus; studentsCanUpload: boolean }) {
  const uploadHref = `/teacher/assignments/${props.assignmentId}/upload`;
  const upload = uploadLabel(props.kind);
  if (!props.studentsCanUpload) {
    return (
      <EmptyState
        title="No papers yet"
        body={`Upload the ${kindNoun(props.kind, true)} on the ${upload} tab: one file per student, or one scan of the whole stack. Papers appear here, grouped by section, as they're graded.`}
        action={<LinkButton href={uploadHref}>{upload}</LinkButton>}
      />
    );
  }
  return (
    <EmptyState
      title="No papers yet"
      body={NO_PAPERS_HINT[props.status]}
      action={<LinkButton href={uploadHref} variant="secondary">Upload scanned papers</LinkButton>}
    />
  );
}

/**
 * A scan of the class's papers waiting for the teacher (its papers appear only once they check the split), or one the
 * AI couldn't split or is still splitting. Scans are listed on the upload tab.
 */
function ScanCallout({ assignmentId, kind, scans }: { assignmentId: string; kind: AssignmentKind; scans: BoardView["scans"] }) {
  const uploadHref = `/teacher/assignments/${assignmentId}/upload`;
  const upload = uploadLabel(kind);
  if (scans.review > 0) {
    const href = scans.review === 1 && scans.firstReviewId ? `/teacher/assignments/${assignmentId}/scans/${scans.firstReviewId}` : uploadHref;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-200 bg-warning-50 px-4 py-3">
        <p className="font-medium text-warning-800">
          {scans.review === 1 ? "A scan is" : `${scans.review} scans are`} split and waiting for your check. No paper is made
          from {scans.review === 1 ? "it" : "them"} until you do.
        </p>
        <LinkButton href={href}>Check the split</LinkButton>
      </div>
    );
  }
  if (scans.failed > 0) {
    return (
      <Alert tone="danger" title={scans.failed === 1 ? "A scan couldn't be split" : `${scans.failed} scans couldn't be split`}>
        Split it every few pages or try the AI again on the <Link href={uploadHref}>{upload}</Link> tab.
      </Alert>
    );
  }
  if (scans.splitting > 0 && scans.onePass === scans.splitting) {
    return (
      <Alert tone="info">
        The AI is grading {scans.onePass === 1 ? "your scan" : `${scans.onePass} scans`} in one pass. Papers appear here as
        they&apos;re graded; follow it on the <Link href={uploadHref}>{upload}</Link> tab.
      </Alert>
    );
  }
  if (scans.splitting > 0) {
    return (
      <Alert tone="info">
        The AI is finding where each student&apos;s paper starts in {scans.splitting === 1 ? "your scan" : `${scans.splitting} scans`}.
        If the split looks clean, its papers are graded automatically; if anything looks off, it waits for your check on
        the <Link href={uploadHref}>{upload}</Link> tab.
      </Alert>
    );
  }
  return null;
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
