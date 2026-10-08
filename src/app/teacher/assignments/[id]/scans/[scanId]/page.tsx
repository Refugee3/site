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
import type { ScanReviewView } from "@/lib/types";

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
        <h2 className="text-xl font-semibold">Check the split</h2>
        <p className="break-words text-sm text-muted">
          {shown.originalFilename} · {plural(shown.pageCount, "page")} · uploaded <LocalTime ms={shown.createdAt} />
        </p>
      </div>

      {shown.status === "splitting" && <Splitting view={view} />}
      {shown.status === "failed" && <Failed view={view} />}
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
      {shown.status === "done" && <Done assignmentId={assignment.id} view={view} />}

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
