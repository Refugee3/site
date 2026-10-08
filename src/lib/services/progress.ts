import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getGradingBatchStartedAt } from "@/lib/db/repos/assignments";
import { getKey, listKeyItems, recentExtractionDurations } from "@/lib/db/repos/keys";
import { listOnePassScansInProgress, recentSplitPageDurations } from "@/lib/db/repos/scans";
import { batchCounts, oldestActiveQueuedAt, recentGradingDurations } from "@/lib/db/repos/submissions";
import {
  ESTIMATE_SAMPLE_SIZE, estimateBatchEtaMs, estimateOnePassEtaMs, estimateRemainingPapers, estimateSplitEtaMs, FALLBACK_EXTRACTION_MS,
  FALLBACK_ONE_PASS_PAGE_MS, FALLBACK_PAPER_MS, FALLBACK_SCAN_PAGE_MS, typicalMs,
} from "@/lib/grading/estimates";
import { keyPageCountHint } from "@/lib/grading/split";
import { getWorkerStatus } from "@/lib/jobs/queue";
import type { GradingProgress, Scan, ScanSplitProgress } from "@/lib/types";

// Timing data for the progress bars and timers: typical durations measured on this server, and the current batch.

/** Median of this assignment's last 20 paper gradings, else of every assignment's, else 60 s. */
export function typicalPaperMs(assignmentId: string): number {
  const own = recentGradingDurations(assignmentId, ESTIMATE_SAMPLE_SIZE);
  return typicalMs(own, own.length > 0 ? [] : recentGradingDurations(null, ESTIMATE_SAMPLE_SIZE), FALLBACK_PAPER_MS);
}

/** Median of the last 20 answer-key readings on this server (an assignment has one key), else 45 s. */
export function typicalExtractionMs(): number {
  return typicalMs([], recentExtractionDurations(ESTIMATE_SAMPLE_SIZE), FALLBACK_EXTRACTION_MS);
}

/** Median ms per page of this assignment's last 20 AI splits, else of every assignment's, else 2 s. */
export function typicalScanPageMs(assignmentId: string): number {
  const own = recentSplitPageDurations(assignmentId, ESTIMATE_SAMPLE_SIZE);
  return typicalMs(own, own.length > 0 ? [] : recentSplitPageDurations(null, ESTIMATE_SAMPLE_SIZE), FALLBACK_SCAN_PAGE_MS);
}

/** Median ms per page of this assignment's last 20 scans graded in one pass, else of every assignment's, else 10 s. */
export function typicalOnePassPageMs(assignmentId: string): number {
  const own = recentSplitPageDurations(assignmentId, ESTIMATE_SAMPLE_SIZE, { onePass: true });
  const everywhere = own.length > 0 ? [] : recentSplitPageDurations(null, ESTIMATE_SAMPLE_SIZE, { onePass: true });
  return typicalMs(own, everywhere, FALLBACK_ONE_PASS_PAGE_MS);
}

/** How many papers the worker grades at once right now (lower for a while after a rate limit). */
export function currentConcurrency(): number {
  return getWorkerStatus()?.effectiveConcurrency ?? getConfig().concurrency;
}

/**
 * The assignment's current grading batch, or null while none of its papers is queued or being graded and none of its scans is
 * being graded in one pass. The batch is every paper queued since assignments.batch_started_at (set when a paper is queued
 * while none is waiting, or a scan's grading in one pass starts); papers still waiting from before it (a restart) count too.
 * Papers a scan grades in one pass are stored graded, so they count as done; the papers it has yet to grade are estimated.
 */
export function getGradingProgress(assignmentId: string): GradingProgress | null {
  const batch = currentBatch(assignmentId);
  if (!batch) return null;
  const { counts, startedAt, onePass } = batch;
  const typical = typicalPaperMs(assignmentId);
  const at = now();
  const batchEta = estimateBatchEtaMs({
    queued: counts.queued,
    inFlightElapsedMs: counts.gradingStartedAts.map((started) => at - started),
    concurrency: currentConcurrency(),
    typicalMs: typical,
  });
  const onePassEta = onePass.scans.reduce((longest, scan) => Math.max(longest, onePassEtaMs(scan)), 0);
  return {
    done: counts.done,
    total: counts.done + counts.queued + counts.grading + onePass.remainingPapers,
    queued: counts.queued,
    grading: counts.grading,
    startedAt,
    typicalPaperMs: typical,
    etaMs: Math.max(batchEta, onePassEta),
    onePass: onePass.scans.length === 0 ? null : { scans: onePass.scans.length, remainingPapers: onePass.remainingPapers },
  };
}

/** The dashboard's short form of getGradingProgress: no estimates. */
export function getGradingCounts(assignmentId: string): { done: number; total: number } | null {
  const batch = currentBatch(assignmentId);
  if (!batch) return null;
  const { counts, onePass } = batch;
  return { done: counts.done, total: counts.done + counts.queued + counts.grading + onePass.remainingPapers };
}

function currentBatch(assignmentId: string) {
  const scans = listOnePassScansInProgress(assignmentId);
  const oldestActive = oldestActiveQueuedAt(assignmentId);
  if (oldestActive === null && scans.length === 0) return null;
  const startedAt = getGradingBatchStartedAt(assignmentId)
    ?? Math.min(...[oldestActive ?? Infinity, ...scans.map((scan) => scan.splitStartedAt ?? scan.createdAt)]);
  const counts = batchCounts(assignmentId, startedAt);
  if (counts.queued + counts.grading === 0 && scans.length === 0) return null;
  let remainingPapers = 0;
  if (scans.length > 0) {
    const key = getKey(assignmentId);
    const keyPageCount = key ? keyPageCountHint(key, listKeyItems(assignmentId)) : null;
    for (const scan of scans) {
      remainingPapers += estimateRemainingPapers({
        pageCount: scan.pageCount, pagesDone: onePassPagesDone(scan), papersSoFar: scan.onePass?.papers.length ?? 0, keyPageCount,
      });
    }
  }
  return { counts, startedAt, onePass: { scans, remainingPapers } };
}

/** Pages of a scan graded in one pass whose papers are stored. */
function onePassPagesDone(scan: Scan): number {
  return scan.onePass ? scan.onePass.nextPage - 1 : 0;
}

function onePassEtaMs(scan: Scan): number {
  const startedAt = scan.splitStartedAt ?? scan.updatedAt;
  return estimateOnePassEtaMs({
    pageCount: scan.pageCount, pagesDone: onePassPagesDone(scan), elapsedMs: now() - startedAt, perPageMs: typicalOnePassPageMs(scan.assignmentId),
  });
}

/** A scan's split (or its grading in one pass) while the AI reads it; null in any other status. */
export function getSplitProgress(scan: Scan): ScanSplitProgress | null {
  if (scan.status !== "splitting") return null;
  const splitStartedAt = scan.splitStartedAt ?? scan.updatedAt;
  if (scan.splitMode === "one_pass") {
    return {
      splitStartedAt,
      pagesRead: onePassPagesDone(scan),
      pageCount: scan.pageCount,
      etaMs: onePassEtaMs(scan),
      papersGraded: scan.onePass?.papers.filter((paper) => paper.submissionId !== null).length ?? 0,
    };
  }
  return {
    splitStartedAt,
    pagesRead: scan.pagesRead,
    pageCount: scan.pageCount,
    etaMs: estimateSplitEtaMs({ pageCount: scan.pageCount, elapsedMs: now() - splitStartedAt, perPageMs: typicalScanPageMs(scan.assignmentId) }),
    papersGraded: null,
  };
}
