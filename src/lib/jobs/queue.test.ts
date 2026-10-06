import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueExtractKey, enqueueGrade, getWorkerStatus, kickWorker, PRIORITY } from "@/lib/jobs/queue";
import { jobRows } from "@/lib/jobs/test-utils";
import type { WorkerStatus } from "@/lib/types";
import { seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

const slots = globalThis as unknown as Record<symbol, unknown>;
const STATUS: WorkerStatus = { state: "running", reason: null, aiMode: "fake", queued: 0, running: 0 };

beforeEach(() => {
  useTestDb();
});

describe("without a worker in this process", () => {
  it("kickWorker is a no-op and there is no status", () => {
    expect(() => kickWorker()).not.toThrow();
    expect(getWorkerStatus()).toBeNull();
  });
});

describe("with a worker registered", () => {
  it("enqueueing kicks the worker and uses JOB_MAX_ATTEMPTS", () => {
    vi.stubEnv("JOB_MAX_ATTEMPTS", "2");
    const kick = vi.fn();
    slots[Symbol.for("pag.worker")] = { kick, status: () => STATUS, stop: async () => {} };
    const assignment = seedAssignment(seedTeacher().id);
    const submission = seedSubmission(assignment.id);

    enqueueGrade(submission.id, assignment.id, PRIORITY.teacher);
    enqueueExtractKey(assignment.id);

    expect(kick).toHaveBeenCalledTimes(2);
    expect(jobRows(submission.id)).toMatchObject([{ kind: "grade_submission", status: "queued", priority: 20, max_attempts: 2 }]);
    expect(jobRows(assignment.id)).toMatchObject([{ kind: "extract_key", status: "queued", priority: 0, max_attempts: 2 }]);
    expect(getWorkerStatus()).toBe(STATUS);
  });
});
