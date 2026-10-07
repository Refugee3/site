import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import type { DB } from "@/lib/db/connection";
import {
  cancelQueuedJobs, claimNextJob, completeJob, enqueueJob, failJob, hasActiveJob, pruneFinishedJobs, queueStats,
  recoverRunningJobs, releasePausedJobs, requeueJob, requeueOrphanedRunningJobs,
} from "@/lib/db/repos/jobs";
import { updateKey } from "@/lib/db/repos/keys";
import { seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import type { Assignment, Job, JobKind } from "@/lib/types";

const T0 = 1_700_000_000_000;

let db: DB;
let assignment: Assignment;

beforeEach(() => {
  setClockForTests(() => T0);
  db = useTestDb();
  assignment = seedAssignment(seedTeacher().id);
  seedApprovedKey(assignment.id, [{}]);
});

function grade(targetId: string, o: { priority?: number; runAfter?: number; assignmentId?: string } = {}): void {
  enqueueJob({
    kind: "grade_submission",
    targetId,
    assignmentId: o.assignmentId ?? assignment.id,
    priority: o.priority ?? 10,
    maxAttempts: 4,
    runAfter: o.runAfter,
  });
}

function jobRows(kind: JobKind, targetId: string): Array<Pick<Job, "status"> & { priority: number; run_after: number }> {
  return db.prepare("SELECT status, priority, run_after FROM jobs WHERE kind = ? AND target_id = ? ORDER BY id")
    .all(kind, targetId) as Array<Pick<Job, "status"> & { priority: number; run_after: number }>;
}

function statusOf(id: number): string {
  return (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;
}

describe("enqueueJob", () => {
  it("keeps one queued row per target; the lowest priority and earliest run_after win", () => {
    grade("s1", { priority: 15, runAfter: T0 + 5_000 });
    grade("s1", { priority: 10, runAfter: T0 + 9_000 });
    grade("s1", { priority: 20, runAfter: T0 + 1_000 });

    expect(jobRows("grade_submission", "s1")).toEqual([{ status: "queued", priority: 10, run_after: T0 + 1_000 }]);
  });

  it("defaults run_after to now and starts with zero attempts", () => {
    grade("s1");
    const job = claimNextJob(T0)!;
    expect(job).toMatchObject({
      targetId: "s1", runAfter: T0, attempts: 1, maxAttempts: 4, maxTokens: null, status: "running", paused: false,
    });
  });

  it("queues a new row beside a running job for the same target", () => {
    grade("s1");
    claimNextJob(T0);
    grade("s1");
    expect(jobRows("grade_submission", "s1").map((r) => r.status)).toEqual(["running", "queued"]);
  });

  it("treats kinds separately", () => {
    grade(assignment.id);
    enqueueJob({ kind: "extract_key", targetId: assignment.id, assignmentId: assignment.id, priority: 0, maxAttempts: 4 });
    expect(queueStats()).toEqual({ queued: 2, running: 0 });
  });
});

describe("claimNextJob", () => {
  it("honours run_after", () => {
    grade("s1", { runAfter: T0 + 1_000 });
    expect(claimNextJob(T0)).toBeNull();
    expect(claimNextJob(T0 + 1_000)?.targetId).toBe("s1");
  });

  it("claims by priority, then run_after, then id", () => {
    grade("teacher-upload", { priority: 20 });
    grade("student-late", { priority: 10, runAfter: T0 - 1_000 });
    grade("student-early", { priority: 10, runAfter: T0 - 2_000 });
    grade("student-tie", { priority: 10, runAfter: T0 - 2_000 });
    enqueueJob({ kind: "extract_key", targetId: assignment.id, assignmentId: assignment.id, priority: 0, maxAttempts: 4 });

    const order = [1, 2, 3, 4, 5].map(() => claimNextJob(T0)?.targetId);
    expect(order).toEqual([assignment.id, "student-early", "student-tie", "student-late", "teacher-upload"]);
    expect(claimNextJob(T0)).toBeNull();
  });

  it("skips a target that already has a running job", () => {
    grade("s1", { priority: 10 });
    expect(claimNextJob(T0)?.targetId).toBe("s1");
    grade("s1", { priority: 0 });
    grade("s2", { priority: 50 });

    expect(claimNextJob(T0)?.targetId).toBe("s2");
    expect(claimNextJob(T0)).toBeNull();
  });

  it("makes grade jobs wait for an approved key, but never extraction jobs", () => {
    const draft = seedAssignment(seedTeacher().id);
    grade("waiting", { assignmentId: draft.id });
    expect(claimNextJob(T0)).toBeNull();

    enqueueJob({ kind: "extract_key", targetId: draft.id, assignmentId: draft.id, priority: 0, maxAttempts: 4 });
    expect(claimNextJob(T0)?.kind).toBe("extract_key");

    updateKey(draft.id, { status: "ready", revision: 2, approvedRevision: 1 });
    expect(claimNextJob(T0)).toBeNull();

    updateKey(draft.id, { approvedRevision: 2 });
    expect(claimNextJob(T0)?.targetId).toBe("waiting");
  });

  it("claims split_scan jobs without an approved key", () => {
    const draft = seedAssignment(seedTeacher().id);
    grade("waiting", { assignmentId: draft.id });
    enqueueJob({ kind: "split_scan", targetId: "scan-1", assignmentId: draft.id, priority: 5, maxAttempts: 4 });

    expect(claimNextJob(T0)).toMatchObject({ kind: "split_scan", targetId: "scan-1", status: "running" });
    expect(claimNextJob(T0)).toBeNull();
  });

  it("counts the attempt and stamps updated_at", () => {
    grade("s1");
    const job = claimNextJob(T0 + 5)!;
    expect(job.attempts).toBe(1);
    expect(job.updatedAt).toBe(T0 + 5);
  });
});

describe("finishing jobs", () => {
  it("completeJob and failJob set the final status and finished_at", () => {
    grade("s1");
    grade("s2");
    const first = claimNextJob(T0)!;
    const second = claimNextJob(T0)!;
    setClockForTests(() => T0 + 100);

    completeJob(first.id);
    failJob(second.id, "boom");

    const rows = db.prepare("SELECT id, status, last_error, finished_at FROM jobs ORDER BY id").all();
    expect(rows).toEqual([
      { id: first.id, status: "done", last_error: null, finished_at: T0 + 100 },
      { id: second.id, status: "failed", last_error: "boom", finished_at: T0 + 100 },
    ]);
  });
});

describe("requeueJob", () => {
  it("puts a running job back with run_after, last_error and max_tokens", () => {
    grade("s1");
    const job = claimNextJob(T0)!;

    expect(requeueJob(job.id, { runAfter: T0 + 30_000, error: "overloaded", maxTokens: 128_000 })).toBe("requeued");

    expect(claimNextJob(T0 + 29_999)).toBeNull();
    expect(claimNextJob(T0 + 30_000)).toMatchObject({ id: job.id, attempts: 2, maxTokens: 128_000, lastError: "overloaded" });
  });

  it("refunds the attempt when asked and keeps max_tokens when not given", () => {
    enqueueJob({ kind: "grade_submission", targetId: "s1", assignmentId: assignment.id, priority: 10, maxAttempts: 4, maxTokens: 99 });
    const job = claimNextJob(T0)!;

    requeueJob(job.id, { runAfter: T0, error: "paused", refundAttempt: true });

    expect(claimNextJob(T0)).toMatchObject({ id: job.id, attempts: 1, maxTokens: 99 });
  });

  it("marks a job deferred by a worker pause, and claiming it clears the mark", () => {
    grade("s1");
    grade("s2");
    const paused = claimNextJob(T0)!;
    const retried = claimNextJob(T0)!;

    requeueJob(paused.id, { runAfter: T0 + 300_000, error: "auth", refundAttempt: true, paused: true });
    requeueJob(retried.id, { runAfter: T0 + 300_000, error: "overloaded" });

    const pausedRow = () => db.prepare("SELECT paused FROM jobs WHERE id = ?").get(paused.id);
    expect(pausedRow()).toEqual({ paused: 1 });
    expect(db.prepare("SELECT paused FROM jobs WHERE id = ?").get(retried.id)).toEqual({ paused: 0 });
    expect(claimNextJob(T0 + 300_000)).toMatchObject({ id: paused.id, paused: false });
    expect(pausedRow()).toEqual({ paused: 0 });
  });

  it("cancels the job instead when another queued job for the target exists (superseded)", () => {
    grade("s1");
    const job = claimNextJob(T0)!;
    grade("s1", { priority: 15 });

    expect(requeueJob(job.id, { runAfter: T0, error: "retry" })).toBe("superseded");

    expect(jobRows("grade_submission", "s1").map((r) => r.status)).toEqual(["cancelled", "queued"]);
  });

  it("reports superseded for a job that is no longer running", () => {
    grade("s1");
    const job = claimNextJob(T0)!;
    completeJob(job.id);
    expect(requeueJob(job.id, { runAfter: T0, error: "late" })).toBe("superseded");
    expect(statusOf(job.id)).toBe("done");
    expect(requeueJob(9999, { runAfter: T0, error: "gone" })).toBe("superseded");
  });
});

describe("releasePausedJobs", () => {
  it("makes only the jobs a pause deferred runnable now", () => {
    grade("s1");
    grade("s2");
    const paused = claimNextJob(T0)!;
    const backoff = claimNextJob(T0)!;
    requeueJob(paused.id, { runAfter: T0 + 300_000, error: "auth", paused: true });
    requeueJob(backoff.id, { runAfter: T0 + 60_000, error: "overloaded" });
    setClockForTests(() => T0 + 10);

    expect(releasePausedJobs(T0 + 10)).toBe(1);

    expect(db.prepare("SELECT id, run_after, paused, updated_at FROM jobs ORDER BY id").all()).toEqual([
      { id: paused.id, run_after: T0 + 10, paused: 0, updated_at: T0 + 10 },
      { id: backoff.id, run_after: T0 + 60_000, paused: 0, updated_at: T0 },
    ]);
    expect(claimNextJob(T0 + 10)?.id).toBe(paused.id);
    expect(releasePausedJobs(T0 + 20)).toBe(0);
  });
});

describe("recoverRunningJobs", () => {
  it("requeues orphaned running jobs, cancelling those superseded by a queued job", () => {
    grade("s1");
    grade("s2");
    const orphan = claimNextJob(T0)!;
    const superseded = claimNextJob(T0)!;
    grade(superseded.targetId);

    expect(recoverRunningJobs()).toBe(2);

    expect(statusOf(orphan.id)).toBe("queued");
    expect(statusOf(superseded.id)).toBe("cancelled");
    expect(queueStats()).toEqual({ queued: 2, running: 0 });
    expect(claimNextJob(T0)?.id).toBe(orphan.id);
  });

  it("returns 0 when nothing is running", () => {
    grade("s1");
    expect(recoverRunningJobs()).toBe(0);
  });
});

describe("requeueOrphanedRunningJobs", () => {
  it("puts back running jobs except the active ones, cancelling those superseded by a queued job", () => {
    grade("s1");
    grade("s2");
    grade("s3", { runAfter: T0 });
    const active = claimNextJob(T0)!;
    const orphan = claimNextJob(T0)!;
    const superseded = claimNextJob(T0)!;
    grade(superseded.targetId);

    setClockForTests(() => T0 + 5000);
    expect(requeueOrphanedRunningJobs([active.id])).toBe(2);

    expect(statusOf(active.id)).toBe("running");
    expect(statusOf(orphan.id)).toBe("queued");
    expect(statusOf(superseded.id)).toBe("cancelled");
    expect(db.prepare("SELECT run_after FROM jobs WHERE id = ?").get(orphan.id)).toEqual({ run_after: T0 + 5000 });
    expect(requeueOrphanedRunningJobs([active.id])).toBe(0);
    expect(requeueOrphanedRunningJobs([])).toBe(1);
  });
});

describe("queue housekeeping", () => {
  it("cancelQueuedJobs cancels only queued jobs of that kind and target", () => {
    grade("s1");
    const running = claimNextJob(T0)!;
    grade("s1");
    grade("s2");

    cancelQueuedJobs("grade_submission", "s1");

    expect(jobRows("grade_submission", "s1").map((r) => r.status)).toEqual(["running", "cancelled"]);
    expect(statusOf(running.id)).toBe("running");
    expect(hasActiveJob("grade_submission", "s2")).toBe(true);
  });

  it("hasActiveJob sees queued and running jobs only", () => {
    expect(hasActiveJob("grade_submission", "s1")).toBe(false);
    grade("s1");
    expect(hasActiveJob("grade_submission", "s1")).toBe(true);
    const job = claimNextJob(T0)!;
    expect(hasActiveJob("grade_submission", "s1")).toBe(true);
    expect(hasActiveJob("extract_key", "s1")).toBe(false);
    completeJob(job.id);
    expect(hasActiveJob("grade_submission", "s1")).toBe(false);
  });

  it("queueStats counts queued and running jobs", () => {
    grade("s1");
    grade("s2");
    grade("s3");
    claimNextJob(T0);
    expect(queueStats()).toEqual({ queued: 2, running: 1 });
  });

  it("pruneFinishedJobs deletes finished jobs older than the cutoff", () => {
    grade("old");
    grade("new");
    grade("waiting");
    const old = claimNextJob(T0)!;
    completeJob(old.id);
    setClockForTests(() => T0 + 10_000);
    const recent = claimNextJob(T0)!;
    failJob(recent.id, "x");

    expect(pruneFinishedJobs(T0 + 1)).toBe(1);
    expect(db.prepare("SELECT target_id FROM jobs ORDER BY id").all()).toEqual([{ target_id: "new" }, { target_id: "waiting" }]);
  });
});
