import { getGrader } from "@/lib/ai";
import type { Grader } from "@/lib/ai/grader";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getDb, tx } from "@/lib/db/connection";
import {
  claimNextJob, completeJob, failJob, pruneFinishedJobs, queueStats, recoverRunningJobs, requeueJob,
} from "@/lib/db/repos/jobs";
import { listProcessingKeysWithoutJob } from "@/lib/db/repos/keys";
import { deleteExpiredSessions } from "@/lib/db/repos/sessions";
import { listQueuedWithoutJob, resetGradingToQueued } from "@/lib/db/repos/submissions";
import { nextRunAfter } from "@/lib/jobs/backoff";
import { failTarget, handleExtractKey, handleGradeSubmission, type HandlerResult } from "@/lib/jobs/handlers";
import { enqueueExtractKey, enqueueGrade, PRIORITY } from "@/lib/jobs/queue";
import { ensureDataDirs, sweepTmp } from "@/lib/storage/files";
import type { Job, JobKind, WorkerStatus } from "@/lib/types";

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  kick(): void;
  status(): WorkerStatus;
  /** Claims one runnable job and runs it to the end; false when nothing could be claimed. */
  runOnce(): Promise<boolean>;
}

type Handler = (job: Job, grader: Grader, signal: AbortSignal) => Promise<HandlerResult>;

const HANDLERS: Record<JobKind, Handler> = {
  extract_key: handleExtractKey,
  grade_submission: handleGradeSubmission,
};

const CRASH_MESSAGES: Record<JobKind, string> = {
  extract_key: "Internal error while reading the answer key.",
  grade_submission: "Internal error while processing this paper.",
};

const NO_API_KEY = "ANTHROPIC_API_KEY is not set";

/**
 * The in-process job runner (§7). It applies each handler's result to the jobs table, runs at most
 * `concurrency` jobs at once, and claims nothing while it has no grader or is paused.
 */
export function createWorker(o: { grader: Grader | null; concurrency: number; pollMs: number }): Worker {
  // Each running job with the controller that aborts its AI call (on the job timeout, or when the worker stops).
  const inFlight = new Map<Promise<void>, AbortController>();
  let running = false;
  let poller: NodeJS.Timeout | null = null;
  let tickScheduled = false;
  let pausedUntil = 0;
  let pauseReason: string | null = null;

  function pauseState(): string | null {
    if (o.grader === null) return NO_API_KEY;
    return now() < pausedUntil ? pauseReason : null;
  }

  function claim(): Job | null {
    return pauseState() === null ? claimNextJob(now()) : null;
  }

  function launch(job: Job, grader: Grader): Promise<void> {
    // The hard wall-clock limit: the SDK's own timeout only covers the wait for response headers.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), getConfig().jobTimeoutMs);
    timeout.unref();
    const task: Promise<void> = execute(job, grader, abort.signal)
      .catch((e: unknown) => console.error(`[worker] could not record the outcome of job ${job.id}`, e))
      .finally(() => {
        clearTimeout(timeout);
        inFlight.delete(task);
        scheduleTick();
      });
    inFlight.set(task, abort);
    return task;
  }

  async function execute(job: Job, grader: Grader, signal: AbortSignal): Promise<void> {
    let result: HandlerResult;
    try {
      result = await HANDLERS[job.kind](job, grader, signal);
    } catch (e) {
      recoverFromCrash(job, e);
      return;
    }
    apply(job, result);
  }

  function apply(job: Job, result: HandlerResult): void {
    switch (result.kind) {
      case "done":
        completeJob(job.id);
        return;
      case "requeue":
        requeueJob(job.id, {
          runAfter: result.runAfter, error: result.error, maxTokens: result.maxTokens, refundAttempt: result.refundAttempt,
        });
        return;
      case "fail":
        failJob(job.id, result.error);
        return;
      case "pause":
        requeueJob(job.id, { runAfter: result.resumeAt, error: result.reason, refundAttempt: true });
        pausedUntil = result.resumeAt;
        pauseReason = result.reason;
        console.warn(`[worker] paused until ${new Date(result.resumeAt).toISOString()}: ${result.reason}`);
        return;
    }
  }

  /** A handler threw (a bug, or an I/O error it does not expect): retry with backoff while attempts remain. */
  function recoverFromCrash(job: Job, e: unknown): void {
    console.error(`[worker] job ${job.id} (${job.kind}) threw`, e);
    const error = `internal: ${e instanceof Error ? e.message : String(e)}`;
    if (job.attempts < job.maxAttempts) {
      // The target may stay `grading`; startGrading accepts that on the next run.
      requeueJob(job.id, { runAfter: nextRunAfter(now(), job.attempts, null), error });
      return;
    }
    failJob(job.id, error);
    failTarget(job, CRASH_MESSAGES[job.kind]);
  }

  function tick(): void {
    tickScheduled = false;
    if (!running || o.grader === null) return;
    try {
      while (inFlight.size < o.concurrency) {
        const job = claim();
        if (!job) break;
        void launch(job, o.grader);
      }
    } catch (e) {
      console.error("[worker] could not claim a job", e);
    }
  }

  /** setImmediate keeps kicks cheap and safe inside a caller's transaction: the claim runs after it commits. */
  function scheduleTick(): void {
    if (!running || tickScheduled) return;
    tickScheduled = true;
    setImmediate(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      poller = setInterval(tick, o.pollMs);
      poller.unref();
      scheduleTick();
    },
    async stop() {
      running = false;
      if (poller) clearInterval(poller);
      poller = null;
      // Stopping never waits on a slow AI call: aborted calls are retried later like any other.
      for (const abort of inFlight.values()) abort.abort();
      await Promise.allSettled([...inFlight.keys()]);
    },
    kick: scheduleTick,
    status() {
      const reason = running ? pauseState() : null;
      return {
        state: !running ? "stopped" : reason !== null ? "paused" : "running",
        reason,
        // getGrader() only returns null in claude mode without an API key.
        aiMode: o.grader?.mode ?? "claude",
        ...queueStats(),
      };
    },
    async runOnce() {
      if (o.grader === null) return false;
      const job = claim();
      if (!job) return false;
      await launch(job, o.grader);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The process-wide worker (§4 "pag.worker"; queue.ts reads the same slot)

const WORKER_SLOT = Symbol.for("pag.worker");
const slots = globalThis as unknown as Record<symbol, Worker | undefined>;
const POLL_MS = 1000;
const HOUR_MS = 3_600_000;
const FINISHED_JOB_RETENTION_MS = 30 * 24 * HOUR_MS;

/**
 * Called from instrumentation's register(): validates the environment, opens (and migrates) the
 * database, recovers work orphaned by the previous process and starts the worker. Idempotent.
 * Throws on a bad environment, which stops the server from starting.
 */
export async function startWorker(): Promise<void> {
  if (slots[WORKER_SLOT]) return;
  const cfg = getConfig();
  getDb();
  // Taking the slot before the first await makes a concurrent second call return early.
  const worker = withMaintenance(createWorker({ grader: getGrader(), concurrency: cfg.concurrency, pollMs: POLL_MS }));
  slots[WORKER_SLOT] = worker;
  try {
    await ensureDataDirs();
    await sweepTmp(HOUR_MS);
    deleteExpiredSessions(now());
    recoverOrphanedWork();
  } catch (e) {
    delete slots[WORKER_SLOT];
    throw e;
  }
  worker.start();
}

/** Boot recovery: only one instance runs, so anything running or grading now was left by a dead process. */
function recoverOrphanedWork(): void {
  tx(() => {
    const jobs = recoverRunningJobs();
    const papers = resetGradingToQueued();
    const unqueuedPapers = listQueuedWithoutJob();
    for (const s of unqueuedPapers) {
      enqueueGrade(s.id, s.assignmentId, s.source === "student" ? PRIORITY.student : PRIORITY.teacher);
    }
    const unqueuedKeys = listProcessingKeysWithoutJob();
    for (const assignmentId of unqueuedKeys) enqueueExtractKey(assignmentId);
    if (jobs + papers + unqueuedPapers.length + unqueuedKeys.length > 0) {
      console.info(`[worker] recovered ${jobs} jobs and ${papers} papers; re-queued ${unqueuedPapers.length} papers and ${unqueuedKeys.length} keys`);
    }
  });
}

/** Adds the hourly housekeeping to the worker's lifecycle, so stop() also ends it. */
function withMaintenance(worker: Worker): Worker {
  let timer: NodeJS.Timeout | null = null;
  return {
    ...worker,
    start() {
      worker.start();
      timer ??= setInterval(() => void runMaintenance(), HOUR_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await worker.stop();
    },
  };
}

async function runMaintenance(): Promise<void> {
  try {
    deleteExpiredSessions(now());
    pruneFinishedJobs(now() - FINISHED_JOB_RETENTION_MS);
    await sweepTmp(HOUR_MS);
  } catch (e) {
    console.error("[worker] maintenance failed", e);
  }
}
