import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueExtractKey, enqueueGrade, enqueueSplitScan, getWorkerStatus, kickWorker, PRIORITY, resumeWorker,
} from "@/lib/jobs/queue";
import { jobRows } from "@/lib/jobs/test-utils";
import type { WorkerStatus } from "@/lib/types";
import { seedAssignment, seedScan, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

const slots = globalThis as unknown as Record<symbol, unknown>;
const STATUS: WorkerStatus = { state: "running", reason: null, aiMode: "fake", queued: 0, running: 0, keyIssue: null };

beforeEach(() => {
  useTestDb();
});

describe("without a worker in this process", () => {
  it("kickWorker and resumeWorker are no-ops and there is no status", () => {
    expect(() => kickWorker()).not.toThrow();
    expect(() => resumeWorker()).not.toThrow();
    expect(getWorkerStatus()).toBeNull();
  });
});

describe("with a worker registered", () => {
  it("enqueueing kicks the worker and uses JOB_MAX_ATTEMPTS", async () => {
    vi.stubEnv("JOB_MAX_ATTEMPTS", "2");
    const kick = vi.fn();
    slots[Symbol.for("pag.worker")] = { kick, status: () => STATUS, resume: () => {}, stop: async () => {} };
    const assignment = seedAssignment(seedTeacher().id);
    const submission = seedSubmission(assignment.id);
    const scan = await seedScan(assignment.id);

    enqueueGrade(submission.id, assignment.id, PRIORITY.teacher);
    enqueueExtractKey(assignment.id);
    enqueueSplitScan(scan.id, assignment.id);

    expect(kick).toHaveBeenCalledTimes(3);
    expect(jobRows(submission.id)).toMatchObject([{ kind: "grade_submission", status: "queued", priority: 20, max_attempts: 2 }]);
    expect(jobRows(assignment.id)).toMatchObject([{ kind: "extract_key", status: "queued", priority: 0, max_attempts: 2 }]);
    expect(jobRows(scan.id)).toMatchObject([{ kind: "split_scan", status: "queued", priority: 5, max_attempts: 2 }]);
    expect(getWorkerStatus()).toBe(STATUS);
  });

  it("splits scans after key extraction and before any grading", () => {
    expect(PRIORITY.extractKey).toBeLessThan(PRIORITY.splitScan);
    expect(PRIORITY.splitScan).toBeLessThan(Math.min(PRIORITY.student, PRIORITY.regrade, PRIORITY.teacher));
  });

  it("resumeWorker resumes the worker, and logs instead of throwing when it can't", () => {
    const resume = vi.fn();
    slots[Symbol.for("pag.worker")] = { kick: () => {}, status: () => STATUS, resume, stop: async () => {} };
    resumeWorker();
    expect(resume).toHaveBeenCalledTimes(1);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    resume.mockImplementation(() => {
      throw new Error("database is locked");
    });
    expect(() => resumeWorker()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
