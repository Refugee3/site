import { getGrader } from "@/lib/ai";
import type { AiErrorCode } from "@/lib/ai/errors";
import type { Grader } from "@/lib/ai/grader";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getDb, tx } from "@/lib/db/connection";
import {
  claimNextJob, completeJob, failJob, pruneFinishedJobs, queueStats, recoverRunningJobs, releasePausedJobs, requeueJob,
  requeueOrphanedRunningJobs,
} from "@/lib/db/repos/jobs";
import { listProcessingKeysWithoutJob } from "@/lib/db/repos/keys";
import { listSplittingScansWithoutJob, resetCreatingScans } from "@/lib/db/repos/scans";
import { deleteExpiredSessions } from "@/lib/db/repos/sessions";
import { listQueuedWithoutJob, resetGradingToQueued } from "@/lib/db/repos/submissions";
import { nextRunAfter } from "@/lib/jobs/backoff";
import { failTarget, handleExtractKey, handleGradeSubmission, handleSplitScan, type HandlerResult } from "@/lib/jobs/handlers";
import { enqueueExtractKey, enqueueGrade, enqueueSplitScan, PRIORITY } from "@/lib/jobs/queue";
import { ensureDataDirs, sweepTmp } from "@/lib/storage/files";
import type { Job, JobKind, WorkerStatus } from "@/lib/types";

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  kick(): void;
  status(): WorkerStatus;
  /** Claims one runnable job and runs it to the end; false when nothing could be claimed. */
  runOnce(): Promise<boolean>;
  /** Ids of the jobs this worker is running right now. */
  inFlightJobIds(): number[];
  /** Requeues `running` jobs this worker does not run (their outcome was never recorded); returns how many. */
  recoverOrphans(): number;
  /** Ends a pause and makes the jobs it deferred runnable now: the API key changed. */
  resume(): void;
}

type Handler = (job: Job, grader: Grader, signal: AbortSignal) => Promise<HandlerResult>;

const HANDLERS: Record<JobKind, Handler> = {
  extract_key: handleExtractKey,
  grade_submission: handleGradeSubmission,
  split_scan: handleSplitScan,
};

const CRASH_MESSAGES: Record<JobKind, string> = {
  extract_key: "Internal error while reading the answer key.",
  grade_submission: "Internal error while processing this paper.",
  split_scan: "Internal error while reading the scan.",
};

const NO_API_KEY = "No Anthropic API key. Add one in Settings.";
/** After an outcome could not be recorded, the next attempt to put the job back (the database may be busy for a while). */
const ORPHAN_RETRY_MS = 30_000;

/**
 * The in-process job runner. It applies each handler's result to the jobs table, runs at most
 * `concurrency` jobs at once, and claims nothing while it has no grader or is paused. Given a function, it
 * asks it for the grader every time, so a key saved in Settings is used without a restart; running jobs
 * finish on the grader they started with.
 */
export function createWorker(o: { grader: Grader | null | (() => Grader | null); concurrency: number; pollMs: number }): Worker {
  const given = o.grader;
  const currentGrader = typeof given === "function" ? given : () => given;
  // Each running job with the controller that aborts its AI call (on the job timeout, or when the worker stops).
  const inFlight = new Map<Promise<void>, { abort: AbortController; jobId: number }>();
  let running = false;
  let poller: NodeJS.Timeout | null = null;
  let tickScheduled = false;
  let pausedUntil = 0;
  let pauseReason: string | null = null;
  let pauseCode: AiErrorCode | null = null;

  function pauseState(grader: Grader | null): string | null {
    if (grader === null) return NO_API_KEY;
    return isPaused() ? pauseReason : null;
  }

  function isPaused(): boolean {
    return now() < pausedUntil;
  }

  /** Why grading can't run that Settings can fix: no key, a rejected key, or a hosted agent the key can't use. */
  function keyIssue(grader: Grader | null): WorkerStatus["keyIssue"] {
    if (grader === null) return "missing";
    if (!isPaused()) return null;
    return pauseCode === "auth" ? "rejected" : pauseCode === "agent_unavailable" ? "agent" : null;
  }

  function claim(): Job | null {
    return pauseState(currentGrader()) === null ? claimNextJob(now()) : null;
  }

  /**
   * currentGrader(), or null when it can't be built: for the status report, which must never fail (the teacher
   * layout and /api/health show it), and for recording an outcome.
   */
  function currentGraderOrNull(): Grader | null {
    try {
      return currentGrader();
    } catch (e) {
      console.error("[worker] could not build the grader", e);
      return null;
    }
  }

  function launch(job: Job, grader: Grader): Promise<void> {
    // The hard wall-clock limit: the SDK's own timeout only covers the wait for response headers.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), getConfig().jobTimeoutMs);
    timeout.unref();
    const task: Promise<void> = execute(job, grader, abort.signal)
      .catch((e: unknown) => {
        // The job row is still `running`, which blocks later jobs for its paper or key until it is put back.
        console.error(`[worker] could not record the outcome of job ${job.id}`, e);
        scheduleOrphanRecovery();
      })
      .finally(() => {
        clearTimeout(timeout);
        inFlight.delete(task);
        scheduleTick();
      });
    inFlight.set(task, { abort, jobId: job.id });
    return task;
  }

  function inFlightJobIds(): number[] {
    return [...inFlight.values()].map((run) => run.jobId);
  }

  /** Handlers are idempotent per grading generation and key run, so running an orphaned job again is safe. */
  function recoverOrphans(): number {
    const recovered = requeueOrphanedRunningJobs(inFlightJobIds());
    if (recovered > 0) console.info(`[worker] put back ${recovered} running jobs whose outcome was not recorded`);
    scheduleTick();
    return recovered;
  }

  function scheduleOrphanRecovery(): void {
    if (!running) return;
    setTimeout(() => {
      if (!running) return; // boot recovery handles it after a restart
      try {
        recoverOrphans();
      } catch (e) {
        console.error("[worker] could not put back orphaned jobs; retrying later", e);
        scheduleOrphanRecovery();
      }
    }, ORPHAN_RETRY_MS).unref();
  }

  async function execute(job: Job, grader: Grader, signal: AbortSignal): Promise<void> {
    let result: HandlerResult;
    try {
      result = await HANDLERS[job.kind](job, grader, signal);
    } catch (e) {
      recoverFromCrash(job, e);
      return;
    }
    apply(job, result, grader);
  }

  /** `grader` is the one the job ran on. */
  function apply(job: Job, result: HandlerResult, grader: Grader): void {
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
        if (grader !== currentGraderOrNull()) {
          // The job ran on a key that was replaced meanwhile (the teacher saved a new one): its failure says nothing
          // about the current key, so it runs again now on that one, and nothing is paused.
          requeueJob(job.id, { runAfter: now(), error: result.reason, refundAttempt: true });
          return;
        }
        // Marked paused, so a key fix (resume) runs it at once while ordinary backoffs keep their run_after.
        requeueJob(job.id, { runAfter: result.resumeAt, error: result.reason, refundAttempt: true, paused: true });
        pausedUntil = result.resumeAt;
        pauseReason = result.reason;
        pauseCode = result.code;
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
    if (!running) return;
    try {
      const grader = currentGrader();
      if (grader === null) return;
      while (inFlight.size < o.concurrency) {
        const job = claim();
        if (!job) break;
        void launch(job, grader);
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
      for (const run of inFlight.values()) run.abort.abort();
      await Promise.allSettled([...inFlight.keys()]);
    },
    kick: scheduleTick,
    status() {
      const grader = currentGraderOrNull();
      const reason = running ? pauseState(grader) : null;
      return {
        state: !running ? "stopped" : reason !== null ? "paused" : "running",
        reason,
        // getGrader() only returns null in claude mode without an API key.
        aiMode: grader?.mode ?? "claude",
        keyIssue: keyIssue(grader),
        ...queueStats(),
      };
    },
    async runOnce() {
      const grader = currentGrader();
      if (grader === null) return false;
      const job = claim();
      if (!job) return false;
      await launch(job, grader);
      return true;
    },
    inFlightJobIds,
    recoverOrphans,
    resume() {
      pausedUntil = 0;
      pauseReason = null;
      pauseCode = null;
      releasePausedJobs(now());
      scheduleTick();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The process-wide worker (globalThis slot "pag.worker"; queue.ts reads the same slot)

const WORKER_SLOT = Symbol.for("pag.worker");
const slots = globalThis as unknown as Record<symbol, Worker | undefined>;
const POLL_MS = 1000;
const HOUR_MS = 3_600_000;
const FINISHED_JOB_RETENTION_MS = 30 * 24 * HOUR_MS;

/**
 * Called from instrumentation's register(): validates the environment, opens (and migrates) the
 * database, recovers work orphaned by the previous process and starts the worker. Idempotent.
 * Throws on a bad environment or an unusable data directory or database; Next only logs a failed
 * register() and then answers every request with 500, so the caller exits the process instead.
 */
export async function startWorker(): Promise<void> {
  if (slots[WORKER_SLOT]) return;
  const cfg = getConfig();
  // Once per process: the slot check above keeps a second caller (another module copy) from repeating them.
  for (const warning of cfg.startupWarnings) console.warn(`[startup] ${warning}`);
  getDb();
  // Taking the slot before the first await makes a concurrent second call return early.
  const worker = withMaintenance(createWorker({ grader: getGrader, concurrency: cfg.concurrency, pollMs: POLL_MS }));
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

/**
 * Boot recovery: only one instance runs, so anything running, grading or creating papers now was left by a
 * dead process. A restart is also how an ANTHROPIC_API_KEY fix arrives, so jobs a pause deferred run at once.
 */
function recoverOrphanedWork(): void {
  tx(() => {
    const jobs = recoverRunningJobs();
    const papers = resetGradingToQueued();
    const scans = resetCreatingScans();
    const unqueuedPapers = listQueuedWithoutJob();
    for (const s of unqueuedPapers) {
      enqueueGrade(s.id, s.assignmentId, s.source === "student" ? PRIORITY.student : PRIORITY.teacher);
    }
    const unqueuedKeys = listProcessingKeysWithoutJob();
    for (const assignmentId of unqueuedKeys) enqueueExtractKey(assignmentId);
    const unqueuedScans = listSplittingScansWithoutJob();
    for (const scan of unqueuedScans) enqueueSplitScan(scan.id, scan.assignmentId);
    releasePausedJobs(now());
    if (jobs + papers + scans + unqueuedPapers.length + unqueuedKeys.length + unqueuedScans.length > 0) {
      console.info(`[worker] recovered ${jobs} jobs, ${papers} papers and ${scans} scans; `
        + `re-queued ${unqueuedPapers.length} papers, ${unqueuedKeys.length} keys and ${unqueuedScans.length} scans`);
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
      timer ??= setInterval(() => void runMaintenance(worker), HOUR_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await worker.stop();
    },
  };
}

async function runMaintenance(worker: Worker): Promise<void> {
  try {
    worker.recoverOrphans(); // backstop for a recovery that was scheduled but could not run
    deleteExpiredSessions(now());
    pruneFinishedJobs(now() - FINISHED_JOB_RETENTION_MS);
    await sweepTmp(HOUR_MS);
  } catch (e) {
    console.error("[worker] maintenance failed", e);
  }
}
