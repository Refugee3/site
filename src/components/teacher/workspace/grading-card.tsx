"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/link-button";
import { formatPercent, formatPoints } from "@/lib/format";
import type { AssignmentLiveSnapshot, LivePaper, LiveScan } from "@/lib/live/snapshot";
import { GradingProgressCard, ScanSplitProgressBar } from "../progress-widgets";
import { plural } from "../text";

/**
 * Step 3 of the workspace: the grading batch's progress, the scans being read, and a feed of papers as each one finishes (the
 * full results board follows below it).
 */
export function GradingBody({ snapshot, assignmentId }: { snapshot: AssignmentLiveSnapshot; assignmentId: string }) {
  const { progress, counts, recentPapers, scans, worker, serverNow } = snapshot;
  const finished = counts.graded + counts.needs_review;
  return (
    <>
      {progress && (
        <GradingProgressCard progress={progress} serverNow={serverNow} throttledUntil={worker.throttledUntil} halted={worker.halted} />
      )}

      {scans.map((scan) => (
        <ScanRow key={scan.id} scan={scan} assignmentId={assignmentId} serverNow={serverNow} />
      ))}

      {!progress && counts.total > 0 && (
        <p className="font-medium">
          {finished === counts.total && finished > 1 ? `All ${counts.total} papers graded` : `${plural(finished, "paper")} graded`}
          {counts.needs_review > 0 && <span className="text-warning-800"> · {counts.needs_review} need{counts.needs_review === 1 ? "s" : ""} your check</span>}
          {counts.failed > 0 && <span className="text-danger-700"> · {counts.failed} couldn&apos;t be graded</span>}
        </p>
      )}

      {recentPapers.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Just graded</h3>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {recentPapers.map((paper) => (
              <FeedRow key={paper.submissionId} paper={paper} assignmentId={assignmentId} />
            ))}
          </ul>
        </div>
      ) : (
        counts.total === 0 && scans.length === 0 && (
          <p className="text-sm text-muted">Each paper shows up here the moment it is graded, with its score and anything to check.</p>
        )
      )}
    </>
  );
}

function FeedRow({ paper, assignmentId }: { paper: LivePaper; assignmentId: string }) {
  const href = `/teacher/assignments/${assignmentId}/submissions/${paper.submissionId}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5 motion-safe:animate-feed-in">
      <div className="flex min-w-0 flex-col">
        <Link href={href} className="min-w-0 truncate font-medium">
          {paper.name}
        </Link>
        <span className="text-xs text-muted">{paper.section}</span>
      </div>
      <div className="flex items-center gap-2">
        {paper.status === "needs_review" && <Badge tone="warning">Needs your check</Badge>}
        {paper.status === "failed" && <Badge tone="danger">Couldn&apos;t be graded</Badge>}
        {paper.scoreEarnedCenti !== null && paper.scoreMaxCenti !== null && (
          <span className="text-sm font-semibold tabular-nums">
            {formatPoints(paper.scoreEarnedCenti)}/{formatPoints(paper.scoreMaxCenti)}
            <span className="font-normal text-muted"> · {formatPercent(paper.percentTenths)}</span>
          </span>
        )}
      </div>
    </li>
  );
}

function ScanRow({ scan, assignmentId, serverNow }: { scan: LiveScan; assignmentId: string; serverNow: number }) {
  const href = `/teacher/assignments/${assignmentId}/scans/${scan.id}`;
  const name = <span className="break-all">{scan.filename}</span>;
  if (scan.status === "splitting") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-3">
        <p className="text-sm font-medium">
          {scan.splitMode === "one_pass" ? "Grading the class's scan in one pass: " : "Finding each student's paper in "}
          {name} ({plural(scan.pageCount, "page")})
        </p>
        {scan.progress && <ScanSplitProgressBar split={scan.progress} serverNow={serverNow} />}
        <Link href={href} className="self-start text-sm">Follow the scan</Link>
      </div>
    );
  }
  if (scan.status === "review") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-200 bg-warning-50 p-3">
        <p className="text-sm font-medium text-warning-800">{name} is split and waiting for your check before its papers are graded.</p>
        <LinkButton href={href} size="sm">Check the split</LinkButton>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger-200 bg-danger-50 p-3">
      <p className="text-sm font-medium text-danger-800">
        {name} couldn&apos;t be split{scan.errorMessage ? `: ${scan.errorMessage}` : "."}
      </p>
      <LinkButton href={href} size="sm" variant="secondary">Open the scan</LinkButton>
    </div>
  );
}
