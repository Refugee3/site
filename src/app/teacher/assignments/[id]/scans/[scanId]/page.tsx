import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { boardHref } from "@/components/teacher/board-helpers";
import { DeleteScanButton, RetryAiButton, ScanReview, SplitEveryForm } from "@/components/teacher/scan-review";
import { ScanSplitProgressBar } from "@/components/teacher/progress-widgets";
import { plural } from "@/components/teacher/text";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/link-button";
import { LocalTime } from "@/components/ui/local-time";
import { Spinner } from "@/components/ui/spinner";
import { requireOwnedScan } from "@/lib/auth/dal";
import { now } from "@/lib/clock";
import { getScanReviewView } from "@/lib/services/views";
import { uploadLabel } from "@/lib/format";
import { formatPageRanges } from "@/lib/scan-layout";
import type { ScanReviewView, SkippedPageReason } from "@/lib/types";

const POLL_MS = 3000;

export default async function ScanPage(props: PageProps<"/teacher/assignments/[id]/scans/[scanId]">) {
  await connection();
  const { id, scanId } = await props.params;
  const { assignment, scan } = await requireOwnedScan(scanId);
  // The scan must belong to the assignment in the URL, or the tabs would mix two assignments.
  if (scan.assignmentId !== id) notFound();
  const view = getScanReviewView(scan, assignment);
  const { scan: shown } = view;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Link href={`/teacher/assignments/${assignment.id}/upload`} className="self-start text-sm">
          ← {uploadLabel(assignment.kind)}
        </Link>
        <h2 className="text-xl font-semibold">{shown.splitMode === "one_pass" ? "Grade in one pass" : "Check the split"}</h2>
        <p className="break-words text-sm text-muted">
          {shown.originalFilename} · {plural(shown.pageCount, "page")} · uploaded <LocalTime ms={shown.createdAt} />
        </p>
      </div>

      {shown.status === "splitting" && (shown.splitMode === "one_pass"
        ? <GradingInOnePass assignmentId={assignment.id} view={view} />
        : <Splitting view={view} />)}
      {shown.status === "failed" && (shown.splitMode === "one_pass" ? <OnePassFailed view={view} /> : <Failed view={view} />)}
      {/* A new split (every N pages, the AI again) starts the review afresh. */}
      {shown.status === "review" && <ScanReview key={shown.splitGeneration} assignmentId={assignment.id} view={view} />}
      {shown.status === "creating" && (
        <Card>
          <p className="flex items-center gap-3 text-lg font-semibold">
            <Spinner className="size-6 text-brand-600" />
            Creating papers…
          </p>
        </Card>
      )}
      {shown.status === "done" && (shown.splitMode === "one_pass"
        ? <OnePassDone assignmentId={assignment.id} view={view} />
        : <Done assignmentId={assignment.id} view={view} />)}

      <AutoRefresh intervalMs={shown.status === "splitting" || shown.status === "creating" ? POLL_MS : null} />
    </div>
  );
}

function defaultPages(view: ScanReviewView): number {
  return view.scan.pagesPerPaper ?? view.keyPageCount ?? 1;
}

function Splitting({ view }: { view: ScanReviewView }) {
  const { scan, splitProgress } = view;
  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Spinner className="mt-0.5 size-6 shrink-0 text-brand-600" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-lg font-semibold">Finding where each student&apos;s paper starts…</p>
            {splitProgress ? (
              <ScanSplitProgressBar split={splitProgress} serverNow={now()} />
            ) : (
              <p className="text-muted">Read {scan.pagesRead} of {plural(scan.pageCount, "page")}.</p>
            )}
            <p className="text-sm text-muted">
              This page updates by itself. If the split looks clean, the papers are graded automatically; if anything
              looks off, the split waits here for your check.
            </p>
            {scan.statusNote && <p className="whitespace-pre-wrap text-sm text-muted">{scan.statusNote}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
          <SplitEveryForm scanId={scan.id} defaultPages={defaultPages(view)} label="Split every N pages instead" />
          <DeleteScanButton scanId={scan.id} status={scan.status} />
        </div>
      </div>
    </Card>
  );
}

function Failed({ view }: { view: ScanReviewView }) {
  const { scan } = view;
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="danger" title="The scan couldn't be split automatically">
        {scan.errorMessage && <p className="whitespace-pre-wrap">{scan.errorMessage}</p>}
      </Alert>
      <div className="flex flex-wrap items-end gap-3">
        <SplitEveryForm scanId={scan.id} defaultPages={defaultPages(view)} label="Split every N pages" />
        <RetryAiButton scanId={scan.id} />
        <DeleteScanButton scanId={scan.id} status={scan.status} />
      </div>
    </div>
  );
}

function Done({ assignmentId, view }: { assignmentId: string; view: ScanReviewView }) {
  const { scan } = view;
  const duplicates = scan.duplicateCount ?? 0;
  const skipped =
    duplicates === 0
      ? ""
      : ` (${duplicates} ${duplicates === 1 ? "was already uploaded and was skipped" : "were already uploaded and were skipped"})`;
  return (
    <div className="flex flex-col gap-4">
      {scan.autoGraded && (
        <Alert tone="info">
          The split looked clean, so grading started automatically.{" "}
          <Link href={boardHref(assignmentId, "all")}>Follow it on the Submissions board</Link>
        </Alert>
      )}
      <Alert tone="success">
        Created {plural(scan.createdCount ?? 0, "paper")}
        {skipped}. They&apos;re being graded now.
      </Alert>
      <div className="flex flex-wrap items-start gap-3">
        <LinkButton href={boardHref(assignmentId, "all")}>See the papers</LinkButton>
        <DeleteScanButton scanId={scan.id} status={scan.status} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Graded in one pass

const SKIPPED_REASON: Record<SkippedPageReason, string> = {
  blank: "blank",
  cover_or_separator: "cover or separator pages",
  answer_key: "answer key pages",
  other: "not part of a paper",
  unassigned: "in no paper (the papers next to them are flagged)",
};

/** Pages in no paper, by reason: "Pages 4, 9 (blank); page 12 (in no paper …)". Empty when there are none. */
function skippedText(skipped: NonNullable<ScanReviewView["onePass"]>["skipped"]): string {
  const byReason = new Map<SkippedPageReason, number[]>();
  for (const { page, reason } of skipped) byReason.set(reason, [...(byReason.get(reason) ?? []), page]);
  return [...byReason]
    .map(([reason, pages]) => `${pages.length === 1 ? "page" : "pages"} ${formatPageRanges(pages)} (${SKIPPED_REASON[reason]})`)
    .join("; ");
}

function GradingInOnePass({ assignmentId, view }: { assignmentId: string; view: ScanReviewView }) {
  const { scan, splitProgress, onePass } = view;
  const started = (onePass?.pagesDone ?? 0) > 0 || (onePass?.papersGraded ?? 0) > 0;
  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Spinner className="mt-0.5 size-6 shrink-0 text-brand-600" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-lg font-semibold">Grading the papers in one pass…</p>
            {splitProgress ? (
              <ScanSplitProgressBar split={splitProgress} serverNow={now()} />
            ) : (
              <p className="text-muted">Graded {scan.pagesRead} of {plural(scan.pageCount, "page")}.</p>
            )}
            <p className="text-sm text-muted">
              This page updates by itself. The AI reads each page once, finds whose paper it is and grades it; papers it
              isn&apos;t sure about are flagged for your review. Graded papers appear on the{" "}
              <Link href={boardHref(assignmentId, "all")}>Submissions board</Link> as they&apos;re done.
            </p>
            {scan.statusNote && <p className="whitespace-pre-wrap text-sm text-muted">{scan.statusNote}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
          {!started && <SplitEveryForm scanId={scan.id} defaultPages={defaultPages(view)} label="Split every N pages instead" />}
          <DeleteScanButton scanId={scan.id} status={scan.status} />
        </div>
      </div>
    </Card>
  );
}

function OnePassFailed({ view }: { view: ScanReviewView }) {
  const { scan, onePass } = view;
  const graded = onePass?.papersGraded ?? 0;
  const started = (onePass?.pagesDone ?? 0) > 0 || graded > 0;
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="danger" title="The scan couldn't be graded in one pass">
        {scan.errorMessage && <p className="whitespace-pre-wrap">{scan.errorMessage}</p>}
        {started && (
          <p>
            {plural(graded, "paper")} from pages 1–{onePass?.pagesDone ?? 0} {graded === 1 ? "was" : "were"} graded and{" "}
            {graded === 1 ? "stays" : "stay"} on the Submissions board.
          </p>
        )}
      </Alert>
      <div className="flex flex-wrap items-end gap-3">
        <RetryAiButton scanId={scan.id} label={started ? "Grade the rest" : "Try again"} mode="one_pass" />
        {!started && (
          <>
            <RetryAiButton scanId={scan.id} label="Split first, then grade" mode="auto" />
            <SplitEveryForm scanId={scan.id} defaultPages={defaultPages(view)} label="Split every N pages" />
          </>
        )}
        <DeleteScanButton scanId={scan.id} status={scan.status} />
      </div>
    </div>
  );
}

function OnePassDone({ assignmentId, view }: { assignmentId: string; view: ScanReviewView }) {
  const { scan, onePass } = view;
  const graded = onePass?.papersGraded ?? scan.createdCount ?? 0;
  const duplicates = onePass?.duplicates ?? 0;
  const flagged = onePass?.flagged ?? 0;
  const skipped = skippedText(onePass?.skipped ?? []);
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="success">
        <p>
          Graded {plural(graded, "paper")} in one pass.{" "}
          <Link href={boardHref(assignmentId, "all")}>See them on the Submissions board</Link>
        </p>
        {duplicates > 0 && (
          <p>
            {duplicates} {duplicates === 1 ? "paper was already uploaded and was skipped" : "papers were already uploaded and were skipped"}.
          </p>
        )}
      </Alert>
      {flagged > 0 && (
        <Alert tone="warning">
          The AI wasn&apos;t sure where {flagged === 1 ? "1 paper starts or ends" : `${flagged} papers start or end`}: check{" "}
          {flagged === 1 ? "its" : "their"} pages when you review {flagged === 1 ? "it" : "them"} (flag &ldquo;Check the paper&apos;s
          pages&rdquo;).
        </Alert>
      )}
      {skipped !== "" && <p className="text-sm text-muted">Left out of every paper: {skipped}.</p>}
      <div className="flex flex-wrap items-start gap-3">
        <LinkButton href={boardHref(assignmentId, "all")}>See the papers</LinkButton>
        <DeleteScanButton scanId={scan.id} status={scan.status} />
      </div>
    </div>
  );
}
