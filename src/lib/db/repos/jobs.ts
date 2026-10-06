import { now } from "@/lib/clock";
import { tx } from "@/lib/db/connection";
import { all, one, run } from "@/lib/db/sql";
import type { Job, JobKind, JobStatus } from "@/lib/types";

interface JobRow {
  id: number;
  kind: JobKind;
  target_id: string;
  assignment_id: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: number;
  max_tokens: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

function jobFromRow(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    assignmentId: row.assignment_id,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    maxTokens: row.max_tokens,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Queues a job, or merges into the target's existing queued job (at most one per (kind, target)):
 * the lower priority and the earlier run_after win.
 */
export function enqueueJob(j: {
  kind: JobKind; targetId: string; assignmentId: string; priority: number; maxAttempts: number;
  runAfter?: number; maxTokens?: number | null;
}): void {
  const at = now();
  run(
    `INSERT INTO jobs (kind, target_id, assignment_id, status, priority, attempts, max_attempts, run_after, max_tokens,
       created_at, updated_at)
     VALUES (@kind, @target_id, @assignment_id, 'queued', @priority, 0, @max_attempts, @run_after, @max_tokens, @at, @at)
     ON CONFLICT (kind, target_id) WHERE status = 'queued' DO UPDATE SET
       priority = min(priority, excluded.priority),
       run_after = min(run_after, excluded.run_after),
       updated_at = excluded.updated_at`,
    {
      kind: j.kind,
      target_id: j.targetId,
      assignment_id: j.assignmentId,
      priority: j.priority,
      max_attempts: j.maxAttempts,
      run_after: j.runAfter ?? at,
      max_tokens: j.maxTokens ?? null,
      at,
    },
  );
}

/**
 * Claims the next runnable job (marks it running and counts the attempt). A job waits while its run_after
 * is in the future, while another job for the same target runs, and (grading only) while the key is unapproved.
 */
export function claimNextJob(at: number): Job | null {
  return tx(() => {
    const row = one<JobRow>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = @now
       WHERE id = (
         SELECT j.id FROM jobs j
         WHERE j.status = 'queued' AND j.run_after <= @now
           AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.kind = j.kind AND r.target_id = j.target_id AND r.status = 'running')
           AND (j.kind = 'extract_key' OR EXISTS (SELECT 1 FROM answer_keys k WHERE k.assignment_id = j.assignment_id
                                                  AND k.status = 'ready' AND k.approved_revision = k.revision))
         ORDER BY j.priority, j.run_after, j.id LIMIT 1)
       RETURNING *`,
      { now: at },
    );
    return row ? jobFromRow(row) : null;
  });
}

export function completeJob(id: number): void {
  const at = now();
  run("UPDATE jobs SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", at, at, id);
}

export function failJob(id: number, error: string): void {
  const at = now();
  run(
    "UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    error, at, at, id,
  );
}

function hasQueuedTwin(job: Pick<JobRow, "id" | "kind" | "target_id">): boolean {
  return one(
    "SELECT 1 FROM jobs WHERE kind = ? AND target_id = ? AND status = 'queued' AND id <> ?",
    job.kind, job.target_id, job.id,
  ) !== undefined;
}

/**
 * Puts a running job back in the queue. If a regrade or re-upload queued another job for the same target
 * meanwhile, this one is cancelled instead ("superseded"), since only one queued job per target may exist.
 * A job that is no longer running (e.g. deleted with its assignment) also reports "superseded".
 */
export function requeueJob(
  id: number,
  o: { runAfter: number; error: string; maxTokens?: number | null; refundAttempt?: boolean },
): "requeued" | "superseded" {
  return tx(() => {
    const at = now();
    const job = one<JobRow>("SELECT * FROM jobs WHERE id = ? AND status = 'running'", id);
    if (!job) return "superseded";
    if (hasQueuedTwin(job)) {
      run(
        "UPDATE jobs SET status = 'cancelled', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
        o.error, at, at, id,
      );
      return "superseded";
    }
    run(
      `UPDATE jobs SET status = 'queued', run_after = @run_after, last_error = @error, updated_at = @at,
         max_tokens = CASE WHEN @set_max_tokens THEN @max_tokens ELSE max_tokens END,
         attempts = CASE WHEN @refund THEN max(attempts - 1, 0) ELSE attempts END
       WHERE id = @id`,
      {
        id,
        at,
        run_after: o.runAfter,
        error: o.error,
        set_max_tokens: o.maxTokens === undefined ? 0 : 1,
        max_tokens: o.maxTokens ?? null,
        refund: o.refundAttempt ? 1 : 0,
      },
    );
    return "requeued";
  });
}

export function cancelQueuedJobs(kind: JobKind, targetId: string): void {
  const at = now();
  run(
    "UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE kind = ? AND target_id = ? AND status = 'queued'",
    at, at, kind, targetId,
  );
}

/**
 * Boot recovery (a single instance runs, so every running job is an orphan): running → queued,
 * or → cancelled when a queued job for the same target already exists. Returns the number of jobs recovered.
 */
export function recoverRunningJobs(): number {
  return tx(() => {
    const at = now();
    const cancelled = run(
      `UPDATE jobs SET status = 'cancelled', finished_at = @at, updated_at = @at
       WHERE status = 'running'
         AND EXISTS (SELECT 1 FROM jobs q WHERE q.kind = jobs.kind AND q.target_id = jobs.target_id AND q.status = 'queued')`,
      { at },
    );
    const requeued = run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'", at);
    return cancelled + requeued;
  });
}

export function hasActiveJob(kind: JobKind, targetId: string): boolean {
  return one(
    "SELECT 1 FROM jobs WHERE kind = ? AND target_id = ? AND status IN ('queued', 'running')",
    kind, targetId,
  ) !== undefined;
}

export function queueStats(): { queued: number; running: number } {
  const stats = { queued: 0, running: 0 };
  const rows = all<{ status: "queued" | "running"; n: number }>(
    "SELECT status, count(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY status",
  );
  for (const { status, n } of rows) stats[status] = n;
  return stats;
}

/** Deletes done/failed/cancelled jobs that finished before `before`. */
export function pruneFinishedJobs(before: number): number {
  return run("DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled') AND finished_at < ?", before);
}
