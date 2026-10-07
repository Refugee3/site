import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getGradingBatchStartedAt } from "@/lib/db/repos/assignments";
import { recentExtractionDurations } from "@/lib/db/repos/keys";
import { recentSplitPageDurations } from "@/lib/db/repos/scans";
import { batchCounts, oldestActiveQueuedAt, recentGradingDurations } from "@/lib/db/repos/submissions";
import {
  ESTIMATE_SAMPLE_SIZE, estimateBatchEtaMs, estimateSplitEtaMs, FALLBACK_EXTRACTION_MS, FALLBACK_PAPER_MS, FALLBACK_SCAN_PAGE_MS, typicalMs,
} from "@/lib/grading/estimates";
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

/** How many papers the worker grades at once right now (lower for a while after a rate limit). */
export function currentConcurrency(): number {
  return getWorkerStatus()?.effectiveConcurrency ?? getConfig().concurrency;
}

/**
 * The assignment's current grading batch, or null while none of its papers is queued or being graded. The batch is every
 * paper queued since assignments.batch_started_at (set when a paper is queued while none is waiting); papers still waiting
 * from before it (a restart) count too.
 */
export function getGradingProgress(assignmentId: string): GradingProgress | null {
  const oldestActive = oldestActiveQueuedAt(assignmentId);
  if (oldestActive === null) return null;
  const startedAt = getGradingBatchStartedAt(assignmentId) ?? oldestActive;
  const counts = batchCounts(assignmentId, startedAt);
  if (counts.queued + counts.grading === 0) return null;
  const typical = typicalPaperMs(assignmentId);
  const at = now();
  return {
    done: counts.done,
    total: counts.done + counts.queued + counts.grading,
    queued: counts.queued,
    grading: counts.grading,
    startedAt,
    typicalPaperMs: typical,
    etaMs: estimateBatchEtaMs({
      queued: counts.queued,
      inFlightElapsedMs: counts.gradingStartedAts.map((started) => at - started),
      concurrency: currentConcurrency(),
      typicalMs: typical,
    }),
  };
}

/** The dashboard's short form of getGradingProgress: no estimates. */
export function getGradingCounts(assignmentId: string): { done: number; total: number } | null {
  const oldestActive = oldestActiveQueuedAt(assignmentId);
  if (oldestActive === null) return null;
  const counts = batchCounts(assignmentId, getGradingBatchStartedAt(assignmentId) ?? oldestActive);
  return { done: counts.done, total: counts.done + counts.queued + counts.grading };
}

/** A scan's split while the AI reads it; null in any other status. */
export function getSplitProgress(scan: Scan): ScanSplitProgress | null {
  if (scan.status !== "splitting") return null;
  const splitStartedAt = scan.splitStartedAt ?? scan.updatedAt;
  return {
    splitStartedAt,
    pagesRead: scan.pagesRead,
    pageCount: scan.pageCount,
    etaMs: estimateSplitEtaMs({ pageCount: scan.pageCount, elapsedMs: now() - splitStartedAt, perPageMs: typicalScanPageMs(scan.assignmentId) }),
  };
}
