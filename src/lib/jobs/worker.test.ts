import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { createFakeGrader } from "@/lib/ai/fake";
import type { Grader } from "@/lib/ai/grader";
import { setGraderForTests } from "@/lib/ai/index";
import { setClockForTests } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx, type DB } from "@/lib/db/connection";
import { cancelQueuedJobs, claimNextJob, enqueueJob } from "@/lib/db/repos/jobs";
import { getKey, listKeyItems, updateKey } from "@/lib/db/repos/keys";
import { getSubmission, getSubmissionByReceipt, listItems, requeueForRegrade } from "@/lib/db/repos/submissions";
import { makeGradingOutput } from "@/lib/grading/test-utils";
import { enqueueExtractKey, enqueueGrade, getWorkerStatus, PRIORITY } from "@/lib/jobs/queue";
import { answeringGrader, deferred, drainQueue, jobRows, scriptedGrader } from "@/lib/jobs/test-utils";
import { createWorker, startWorker } from "@/lib/jobs/worker";
import { ingestKeyPdf } from "@/lib/services/keys";
import { ingestStudentUpload, updateIdentity } from "@/lib/services/submissions";
import { submissionPdfRel } from "@/lib/storage/paths";
import type { Assignment } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
let clock = T0;
let db: DB;
let assignment: Assignment;

beforeEach(() => {
  clock = T0;
  setClockForTests(() => clock);
  db = useTestDb();
  assignment = seedAssignment(seedTeacher().id, { status: "open" });
  seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2", pointsCenti: 200 }]);
});

const instantFake = createFakeGrader({ delayMs: 0 });

function workerWith(grader: Grader) {
  return createWorker({ grader, concurrency: 1, pollMs: 1000 });
}

/** Uploads a one-page paper through the student service; returns the submission id. */
async function uploadPaper(label = "paper"): Promise<string> {
  const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [{ filename: `${label}.pdf`, bytes: await makePdf(1, { label }) }]);
  return getSubmissionByReceipt(receiptUrl.slice("/r/".length))!.id;
}

function rejectingGrader(err: AiError): Grader {
  return scriptedGrader({ gradeSubmission: () => Promise.reject(err) });
}

function temporaryError(): AiError {
  return new AiError("overloaded", "temporary trouble", { retryable: true });
}

/**
 * Starts one run whose AI call waits for `gate`; resolves once the call is in flight. The call then
 * answers like the fake grader, or fails with `failWith`.
 */
async function startBlockedRun(o: { kind: "grade" | "extract"; failWith?: AiError }) {
  const gate = deferred<void>();
  const called = deferred<void>();
  const block = async () => {
    called.resolve();
    await gate.promise;
    if (o.failWith) throw o.failWith;
  };
  const grader = o.kind === "grade"
    ? scriptedGrader({ gradeSubmission: async (input, options) => (await block(), instantFake.gradeSubmission(input, options)) })
    : scriptedGrader({ extractKey: async (input, options) => (await block(), instantFake.extractKey(input, options)) });
  const run = workerWith(grader).runOnce();
  await called.promise;
  return { finish: async () => (gate.resolve(), run) };
}

describe("grading with the fake grader", () => {
  it("grades an ingested student upload end to end", async () => {
    const id = await uploadPaper();
    const worker = workerWith(instantFake);

    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);

    const s = getSubmission(id)!;
    expect(["graded", "needs_review"]).toContain(s.status);
    expect(s).toMatchObject({ scoreMaxCenti: 300, gradedKeyRevision: 1, aiModel: "fake" });
    expect(s.scoreEarnedCenti).toEqual(expect.any(Number));
    expect(listItems(id)).toHaveLength(2);
    expect(jobRows(id)).toMatchObject([{ status: "done", attempts: 1 }]);
  });

  it("stores a clean paper as graded with its score", async () => {
    const id = await uploadPaper();
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));

    expect(getSubmission(id)).toMatchObject({
      status: "graded", studentName: "Maria Lopez", nameSource: "ai", scoreEarnedCenti: 300, scoreMaxCenti: 300, flags: [],
    });
  });
});

describe("AI failures", () => {
  it("requeues a retryable error with backoff and fails the paper once attempts run out", async () => {
    const id = await uploadPaper();
    const worker = workerWith(rejectingGrader(temporaryError()));

    for (const [index, base] of [30_000, 120_000, 480_000].entries()) {
      expect(await worker.runOnce()).toBe(true);
      const [job] = jobRows(id);
      expect(job).toMatchObject({ status: "queued", attempts: index + 1, last_error: "overloaded: temporary trouble" });
      expect(job.run_after).toBeGreaterThanOrEqual(clock + base * 0.8);
      expect(job.run_after).toBeLessThanOrEqual(clock + base * 1.2);
      expect(getSubmission(id)).toMatchObject({ status: "queued", statusNote: "Retrying after a temporary AI error" });
      expect(await worker.runOnce()).toBe(false); // not due yet
      clock = job.run_after;
    }

    expect(await worker.runOnce()).toBe(true);
    expect(jobRows(id)).toMatchObject([{ status: "failed", attempts: 4 }]);
    expect(getSubmission(id)).toMatchObject({
      status: "failed", errorCode: "overloaded", errorMessage: "The AI service failed (overloaded).", statusNote: null,
    });
  });

  it("retries a max_tokens stop once with the 128k ceiling, then fails", async () => {
    const id = await uploadPaper();
    const budgets: Array<number | undefined> = [];
    const worker = workerWith(scriptedGrader({
      gradeSubmission: async (_input, options) => {
        budgets.push(options?.maxTokens);
        throw new AiError("max_tokens", "stopped at max_tokens", { retryable: true });
      },
    }));

    await worker.runOnce();
    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 0, max_tokens: 128_000, run_after: T0 }]);

    await worker.runOnce();
    expect(budgets).toEqual([64_000, 128_000]);
    expect(getSubmission(id)).toMatchObject({
      status: "failed", errorCode: "max_tokens",
      errorMessage: "The AI's answer was too long even at the maximum size. Grade this paper manually.",
    });
  });

  it("pauses claiming on a rejected API key and refunds the attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await uploadPaper();
    let rejectKey = true;
    const worker = workerWith(scriptedGrader({
      gradeSubmission: async (input, options) => {
        if (rejectKey) throw new AiError("auth", "invalid x-api-key", { retryable: false, pauseWorker: true });
        return instantFake.gradeSubmission(input, options);
      },
    }));

    await worker.runOnce();
    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 0, run_after: T0 + 300_000 }]);
    expect(getSubmission(id)).toMatchObject({ status: "queued", statusNote: "Paused: API key rejected — check ANTHROPIC_API_KEY" });

    worker.start();
    expect(worker.status()).toMatchObject({ state: "paused", reason: "API key rejected — check ANTHROPIC_API_KEY", queued: 1 });
    await worker.stop();
    expect(worker.status().state).toBe("stopped");

    rejectKey = false;
    clock = T0 + 60_000;
    expect(await worker.runOnce()).toBe(false);
    clock = T0 + 300_000;
    expect(await worker.runOnce()).toBe(true);
    expect(["graded", "needs_review"]).toContain(getSubmission(id)!.status);
  });

  it("sends a refused paper to review with ai_refused and no judgments", async () => {
    const id = await uploadPaper();
    await drainQueue(rejectingGrader(new AiError("refusal", "declined", { retryable: false, refusalCategory: "cyber" })));

    const s = getSubmission(id)!;
    expect(s).toMatchObject({ status: "needs_review", scoreEarnedCenti: 0, scoreMaxCenti: 300, usage: null });
    expect(s.flags).toContain("ai_refused");
    expect(s.teacherSummary).toContain("category: cyber");
    expect(listItems(id).every((item) => item.judgment === null)).toBe(true);
    expect(jobRows(id)).toMatchObject([{ status: "done" }]);
  });

  it("retries an answer that skips most items", async () => {
    const id = await uploadPaper();
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, { items: [] })));

    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 1, last_error: expect.stringMatching(/^invalid_output/) }]);
    expect(getSubmission(id)).toMatchObject({ status: "queued", statusNote: "Retrying after a temporary AI error" });
  });

  it("marks a paper failed when its PDF is missing", async () => {
    const s = seedSubmission(assignment.id);
    enqueueGrade(s.id, assignment.id, PRIORITY.student);
    await drainQueue();

    expect(getSubmission(s.id)).toMatchObject({ status: "failed", errorCode: "file_missing" });
    expect(jobRows(s.id)).toMatchObject([{ status: "failed" }]);
  });
});

describe("races and crashes", () => {
  /** What a regrade writes; the service refuses papers that are still grading, so the race is staged with the repos. */
  function regradeNow(id: string): void {
    tx(() => {
      requeueForRegrade(id);
      enqueueGrade(id, assignment.id, PRIORITY.regrade);
    });
  }

  it("discards a result when the paper was regraded mid-call", async () => {
    const id = await uploadPaper();
    const run = await startBlockedRun({ kind: "grade" });
    expect(getSubmission(id)!.status).toBe("grading");

    regradeNow(id);
    await run.finish();

    expect(getSubmission(id)).toMatchObject({ status: "queued", gradingGeneration: 2, gradedAt: null });
    expect(listItems(id)).toEqual([]);
    expect(jobRows(id).map((job) => job.status)).toEqual(["done", "queued"]);

    await drainQueue();
    expect(getSubmission(id)).toMatchObject({ gradingGeneration: 2, gradedKeyRevision: 1 });
  });

  it("lets an old job's retry give way to the regrade's job (no second queued row)", async () => {
    const id = await uploadPaper();
    const run = await startBlockedRun({ kind: "grade", failWith: temporaryError() });

    regradeNow(id);
    await run.finish();

    expect(jobRows(id)).toMatchObject([{ status: "done" }, { status: "queued", priority: PRIORITY.regrade }]);
    expect(getSubmission(id)).toMatchObject({ status: "queued", gradingGeneration: 2, statusNote: null });
  });

  it("writes nothing when the paper was deleted mid-call", async () => {
    const id = await uploadPaper();
    const run = await startBlockedRun({ kind: "grade" });

    db.prepare("DELETE FROM submissions WHERE id = ?").run(id);
    await run.finish();

    expect(getSubmission(id)).toBeNull();
    expect(jobRows(id)).toMatchObject([{ status: "done" }]);
  });

  it("keeps a name the teacher entered while the paper was being graded", async () => {
    const id = await uploadPaper();
    const run = await startBlockedRun({ kind: "grade" });

    updateIdentity(getSubmission(id)!, { studentName: "Ana Diaz", sectionId: null });
    await run.finish();

    const s = getSubmission(id)!;
    expect(s).toMatchObject({ studentName: "Ana Diaz", nameSource: "teacher", gradingGeneration: 1 });
    expect(s.aiName).toEqual(expect.any(String));
    expect(s.flags).not.toContain("name_missing");
  });

  it("picks up a paper left in grading after its handler threw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = seedSubmission(assignment.id, { pdfPath: "not/a/data/path.pdf" });
    enqueueGrade(s.id, assignment.id, PRIORITY.student);
    const worker = workerWith(instantFake);

    await worker.runOnce();
    const [job] = jobRows(s.id);
    expect(job).toMatchObject({ status: "queued", attempts: 1, last_error: expect.stringMatching(/^internal: /) });
    expect(job.run_after).toBeGreaterThan(T0);
    expect(getSubmission(s.id)!.status).toBe("grading");

    // Repair the row so that the next attempt can read the file.
    const pdfPath = submissionPdfRel(assignment.id, s.id);
    const file = path.join(getConfig().dataDir, pdfPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await makePdf(1));
    db.prepare("UPDATE submissions SET pdf_path = ? WHERE id = ?").run(pdfPath, s.id);
    clock = job.run_after;

    expect(await worker.runOnce()).toBe(true);
    expect(["graded", "needs_review"]).toContain(getSubmission(s.id)!.status);
    expect(jobRows(s.id)).toMatchObject([{ status: "done", attempts: 2 }]);
  });

  it("fails the paper when its handler throws on the last attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = seedSubmission(assignment.id, { pdfPath: "not/a/data/path.pdf" });
    enqueueJob({ kind: "grade_submission", targetId: s.id, assignmentId: assignment.id, priority: PRIORITY.student, maxAttempts: 1 });

    await drainQueue();

    expect(jobRows(s.id)).toMatchObject([{ status: "failed" }]);
    expect(getSubmission(s.id)).toMatchObject({
      status: "failed", errorCode: "internal", errorMessage: "Internal error while processing this paper.",
    });
  });
});

describe("key extraction", () => {
  let draft: Assignment;

  beforeEach(async () => {
    draft = seedAssignment(seedTeacher().id);
    await ingestKeyPdf(draft, { filename: "key.pdf", bytes: await makePdf(2, { label: "key" }) });
  });

  it("turns the key PDF into items that wait for the teacher's approval", async () => {
    await drainQueue();

    expect(getKey(draft.id)).toMatchObject({
      status: "ready", revision: 1, approvedRevision: null, documentKind: "answer_key", errorMessage: null, aiModel: "fake",
      fingerprint: expect.any(String),
    });
    expect(listKeyItems(draft.id).map((item) => item.label)).toEqual(["1", "2", "3a", "3b", "4", "5"]);
    expect(jobRows(draft.id)).toMatchObject([{ kind: "extract_key", status: "done" }]);
  });

  it("fails the key when the AI declines to read it", async () => {
    const refusal = new AiError("refusal", "declined", { retryable: false, refusalCategory: null });
    await drainQueue(scriptedGrader({ extractKey: () => Promise.reject(refusal) }));

    expect(getKey(draft.id)).toMatchObject({
      status: "failed", errorMessage: "The AI declined to read this document. Build the key manually.",
    });
    expect(jobRows(draft.id)).toMatchObject([{ status: "failed" }]);
  });

  /** What a re-upload writes; the service refuses while the key is processing, so the race is staged with the repos. */
  function reuploadKey(): void {
    tx(() => {
      updateKey(draft.id, { sourceSha256: "re-uploaded" });
      cancelQueuedJobs("extract_key", draft.id);
      enqueueExtractKey(draft.id);
    });
  }

  it("discards a result superseded by a re-upload mid-call", async () => {
    const run = await startBlockedRun({ kind: "extract" });
    reuploadKey();
    await run.finish();

    expect(getKey(draft.id)).toMatchObject({ status: "processing", sourceSha256: "re-uploaded", revision: 0 });
    expect(listKeyItems(draft.id)).toEqual([]);
    expect(jobRows(draft.id).map((job) => job.status)).toEqual(["done", "queued"]);
  });

  it("cancels a retry superseded by a re-upload instead of queueing it twice", async () => {
    const run = await startBlockedRun({ kind: "extract", failWith: temporaryError() });
    reuploadKey();
    await run.finish();

    expect(jobRows(draft.id).map((job) => job.status)).toEqual(["cancelled", "queued"]);
    expect(getKey(draft.id)!.status).toBe("processing");
  });
});

describe("startWorker", () => {
  const workerSlot = () => (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pag.worker")];

  it("recovers work orphaned by a dead process and stays paused without an API key", async () => {
    setGraderForTests(null);
    const orphaned = seedSubmission(assignment.id, { status: "grading" });
    enqueueGrade(orphaned.id, assignment.id, PRIORITY.student);
    expect(claimNextJob(clock)).toMatchObject({ targetId: orphaned.id, status: "running" });
    const unqueued = seedSubmission(assignment.id);
    const scanned = seedSubmission(assignment.id, { source: "teacher" });
    const keyAssignment = seedAssignment(seedTeacher().id);
    updateKey(keyAssignment.id, { status: "processing" });

    vi.spyOn(console, "info").mockImplementation(() => {});
    await startWorker();

    expect(getSubmission(orphaned.id)!.status).toBe("queued");
    expect(jobRows(orphaned.id)).toMatchObject([{ status: "queued", attempts: 1 }]);
    expect(jobRows(unqueued.id)).toMatchObject([{ status: "queued", priority: PRIORITY.student }]);
    expect(jobRows(scanned.id)).toMatchObject([{ status: "queued", priority: PRIORITY.teacher }]);
    expect(jobRows(keyAssignment.id)).toMatchObject([{ kind: "extract_key", status: "queued", priority: PRIORITY.extractKey }]);
    expect(getWorkerStatus()).toEqual({ state: "paused", reason: "ANTHROPIC_API_KEY is not set", aiMode: "claude", queued: 4, running: 0 });
  });

  it("is idempotent", async () => {
    setGraderForTests(null);
    await startWorker();
    const first = workerSlot();
    await startWorker();
    expect(workerSlot()).toBe(first);
  });

  it("runs queued work in the background", async () => {
    setClockForTests(null);
    setGraderForTests(answeringGrader((refs) => makeGradingOutput(refs)));
    await startWorker();
    const id = await uploadPaper();

    await vi.waitFor(() => expect(getSubmission(id)!.status).toBe("graded"));
    expect(getWorkerStatus()).toMatchObject({ state: "running", aiMode: "fake", queued: 0 });
  });
});

describe("worker lifecycle", () => {
  /** A grader whose calls hang until their signal aborts or `release` is called. */
  function hangingGrader() {
    const calls: Array<() => void> = [];
    const grader = scriptedGrader({
      gradeSubmission: (input, options) => new Promise((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new AiError("aborted", "aborted", { retryable: true })));
        calls.push(() => resolve(instantFake.gradeSubmission(input, options)));
      }),
    });
    return { grader, calls };
  }

  it("runs at most `concurrency` jobs at once", async () => {
    const ids = [await uploadPaper("a"), await uploadPaper("b"), await uploadPaper("c")];
    const { grader, calls } = hangingGrader();
    const worker = createWorker({ grader, concurrency: 2, pollMs: 1000 });

    worker.start();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(2);
    expect(worker.status()).toMatchObject({ state: "running", queued: 1, running: 2 });

    for (const release of calls.splice(0)) release();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0]();
    await vi.waitFor(() => expect(ids.map((id) => getSubmission(id)!.status)).not.toContain("grading"));
    await worker.stop();
    expect(ids.every((id) => jobRows(id)[0].status === "done")).toBe(true);
  });

  it("stop() aborts in-flight AI calls instead of waiting for them, and their jobs retry later", async () => {
    const id = await uploadPaper();
    const { grader, calls } = hangingGrader();
    const worker = workerWith(grader);

    worker.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await worker.stop();

    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 1, last_error: "aborted: aborted" }]);
    expect(getSubmission(id)).toMatchObject({ status: "queued", statusNote: "Retrying after a temporary AI error" });
  });
});
