import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { createFakeGrader } from "@/lib/ai/fake";
import type { GradeInput, Grader } from "@/lib/ai/grader";
import { getGrader, setGraderForTests } from "@/lib/ai/index";
import { guidanceFingerprint, itemRefs, renderGuidance } from "@/lib/ai/prompts";
import type { GradingOutput } from "@/lib/ai/schemas";
import { setClockForTests } from "@/lib/clock";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { tx, type DB } from "@/lib/db/connection";
import { getAssignmentUsage, listSections } from "@/lib/db/repos/assignments";
import * as jobsRepo from "@/lib/db/repos/jobs";
import { cancelQueuedJobs, claimNextJob, enqueueJob } from "@/lib/db/repos/jobs";
import { getKey, listKeyItems, updateKey } from "@/lib/db/repos/keys";
import { getSubmission, getSubmissionByReceipt, listItems, requeueForRegrade } from "@/lib/db/repos/submissions";
import { setGradingPreferences } from "@/lib/db/repos/teachers";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { enqueueExtractKey, enqueueGrade, getWorkerStatus, PRIORITY, resumeWorker } from "@/lib/jobs/queue";
import { answeringGrader, deferred, drainQueue, FAKE_META, jobRows, scriptedGrader } from "@/lib/jobs/test-utils";
import { createWorker, startWorker } from "@/lib/jobs/worker";
import { updateAssignment } from "@/lib/services/assignments";
import { ingestKeyPdf, saveKey } from "@/lib/services/keys";
import { ingestStudentUpload, regradeSubmission, updateIdentity } from "@/lib/services/submissions";
import { submissionPdfRel } from "@/lib/storage/paths";
import type { Assignment, AssignmentFormInput } from "@/lib/types";
import {
  enableStudentUploads, makePdf, seedApprovedKey, seedAssignment, seedLesson, seedSubmission, seedTeacher, useTestDb,
} from "@/test/helpers";

const T0 = 1_700_000_000_000;
let clock = T0;
let db: DB;
let assignment: Assignment;

beforeEach(() => {
  clock = T0;
  setClockForTests(() => clock);
  db = useTestDb();
  enableStudentUploads();
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

/** Like startBlockedRun, but the AI's answer is `answer(refs)`; also records what the grader was sent. */
async function startGatedAnswer(answer: (refs: string[]) => GradingOutput) {
  const gate = deferred<void>();
  const called = deferred<void>();
  const grader = scriptedGrader({
    async gradeSubmission(input) {
      called.resolve();
      await gate.promise;
      const refs = itemRefs(input.items.length);
      return { output: answer(refs), refs, keyPdfIncluded: false, meta: FAKE_META };
    },
  });
  const run = workerWith(grader).runOnce();
  await called.promise;
  return { finish: async () => (gate.resolve(), run) };
}

/** A grader that answers every paper cleanly and records each input it was sent. */
function recordingGrader(inputs: GradeInput[]): Grader {
  return scriptedGrader({
    async gradeSubmission(input) {
      inputs.push(input);
      const refs = itemRefs(input.items.length);
      return { output: makeGradingOutput(refs), refs, keyPdfIncluded: false, meta: FAKE_META };
    },
  });
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

  it("tells the teacher which items were corrected automatically", async () => {
    const id = await uploadPaper();
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, {
      teacher_summary: "Neat work.",
      items: refs.map((ref, index) => makeOutputItem(ref, index === 1 ? { attempt: "complete", correctness: "no_answer" } : {})),
    })));

    expect(getSubmission(id)).toMatchObject({
      status: "needs_review", flags: ["output_repaired"],
      teacherSummary: 'Neat work.\nAutomatic corrections: Item 2: judged "no answer" but marked attempted; set to not attempted.',
    });
  });

  it("adds every graded or refused call to the assignment's usage, by served model", async () => {
    const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 5 };
    const id = await uploadPaper();
    await drainQueue(scriptedGrader({
      async gradeSubmission(input) {
        const refs = itemRefs(input.items.length);
        return { output: makeGradingOutput(refs), refs, keyPdfIncluded: false, meta: { ...FAKE_META, servedModel: "claude-opus-5-5", usage } };
      },
    }));
    regradeSubmission(getSubmission(id)!);
    // An unusable answer is retried, but it was billed all the same.
    const invalid = new AiError("invalid_output", "not JSON", { retryable: true, billed: { servedModel: "claude-opus-5-5", usage } });
    await drainQueue(rejectingGrader(invalid));

    expect(getAssignmentUsage(assignment.id)).toEqual({
      "claude-opus-5-5": { calls: 2, inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 10 },
    });
  });
});

describe("grading with the teacher's guidance", () => {
  it("sends the preferences and lessons, and records the guidance's fingerprint with the grading", async () => {
    setGradingPreferences(assignment.teacherId, "Ignore spelling.");
    const earlier = await uploadPaper("earlier");
    await drainQueue();
    const items = listKeyItems(assignment.id);
    seedLesson({ assignmentId: assignment.id, submissionId: earlier, itemId: items[0].id, studentAnswer: "co2", reason: "Lowercase is fine." });
    const id = await uploadPaper("later");
    const inputs: GradeInput[] = [];

    await drainQueue(recordingGrader(inputs));

    expect(inputs).toHaveLength(1);
    expect(inputs[0].guidance).toEqual({
      preferences: "Ignore spelling.",
      lessons: [expect.objectContaining({ itemId: items[0].id, studentAnswer: "co2", reason: "Lowercase is fine." })],
    });
    const fingerprint = guidanceFingerprint(renderGuidance(inputs[0].guidance, items));
    expect(fingerprint).not.toBe("");
    expect(getSubmission(id)!.gradedGuidanceFp).toBe(fingerprint);
    expect(getSubmission(earlier)!.gradedGuidanceFp).toBe(guidanceFingerprint(renderGuidance({ preferences: "Ignore spelling.", lessons: [] }, items)));
  });

  it("records an empty fingerprint when there is no guidance, also for a refused paper", async () => {
    const id = await uploadPaper();
    await drainQueue(rejectingGrader(new AiError("refusal", "declined", { retryable: false, refusalCategory: "cyber" })));

    expect(getSubmission(id)).toMatchObject({ flags: expect.arrayContaining(["ai_refused"]), gradedGuidanceFp: "" });
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
    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 0, run_after: T0 + 300_000, paused: 1 }]);
    expect(getSubmission(id)).toMatchObject({ status: "queued", statusNote: "Paused: Anthropic rejected the API key. Replace it in Settings." });

    worker.start();
    expect(worker.status()).toMatchObject({
      state: "paused", reason: "Anthropic rejected the API key. Replace it in Settings.", queued: 1, keyIssue: "rejected",
    });
    await worker.stop();
    expect(worker.status().state).toBe("stopped");

    rejectKey = false;
    clock = T0 + 60_000;
    expect(await worker.runOnce()).toBe(false);
    clock = T0 + 300_000;
    expect(await worker.runOnce()).toBe(true);
    expect(["graded", "needs_review"]).toContain(getSubmission(id)!.status);
  });

  it("pauses claiming when the account runs out of credits instead of failing the paper", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await uploadPaper();
    await workerWith(rejectingGrader(new AiError("billing", "credit balance is too low", { retryable: false, pauseWorker: true }))).runOnce();

    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 0, run_after: T0 + 300_000, paused: 1 }]);
    expect(getSubmission(id)).toMatchObject({
      status: "queued", statusNote: "Paused: Billing problem — check the plan and credits in the Anthropic Console",
    });
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

  it("retries a refusal whose fallback model was unavailable, and sends the paper to review once attempts run out", async () => {
    const id = await uploadPaper();
    const refusal = new AiError("refusal", "declined; fallback unavailable", { retryable: true, refusalCategory: "bio" });
    const worker = workerWith(rejectingGrader(refusal));

    for (let attempt = 1; attempt < 4; attempt++) {
      expect(await worker.runOnce()).toBe(true);
      const [job] = jobRows(id);
      expect(job).toMatchObject({ status: "queued", attempts: attempt, last_error: "refusal: declined; fallback unavailable" });
      expect(job.run_after).toBeGreaterThan(clock);
      expect(getSubmission(id)).toMatchObject({ status: "queued", statusNote: "Retrying after a temporary AI error" });
      expect(listItems(id)).toEqual([]);
      clock = job.run_after;
    }

    expect(await worker.runOnce()).toBe(true);
    const s = getSubmission(id)!;
    expect(s).toMatchObject({ status: "needs_review", scoreEarnedCenti: 0 });
    expect(s.flags).toContain("ai_refused");
    expect(jobRows(id)).toMatchObject([{ status: "done", attempts: 4 }]);
  });

  it("grades a paper on the retry after a refusal whose fallback model was unavailable", async () => {
    const id = await uploadPaper();
    let calls = 0;
    const worker = workerWith(scriptedGrader({
      gradeSubmission: async (input, options) => {
        if (++calls === 1) throw new AiError("refusal", "declined", { retryable: true, refusalCategory: null });
        return instantFake.gradeSubmission(input, options);
      },
    }));

    await worker.runOnce();
    clock = jobRows(id)[0].run_after;
    await worker.runOnce();

    expect(calls).toBe(2);
    expect(getSubmission(id)!.flags).not.toContain("ai_refused");
    expect(jobRows(id)).toMatchObject([{ status: "done", attempts: 2 }]);
  });

  it("retries an answer that skips most items", async () => {
    const id = await uploadPaper();
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, { items: [] })));

    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 1, last_error: expect.stringMatching(/^invalid_output/) }]);
    expect(getSubmission(id)).toMatchObject({ status: "queued", statusNote: "Retrying after a temporary AI error" });
  });

  it("never sends a key PDF that the extraction judged to be a student's paper", async () => {
    await ingestKeyPdf(assignment, { filename: "maria.pdf", bytes: await makePdf(1, { label: "maria" }) });
    // A key row from before such PDFs were detached: approved items, but the student's paper still attached.
    updateKey(assignment.id, { status: "ready", revision: 1, approvedRevision: 1, documentKind: "student_work" });
    db.prepare("DELETE FROM jobs WHERE kind = 'extract_key'").run();
    const inputs: GradeInput[] = [];
    await uploadPaper();
    await drainQueue(recordingGrader(inputs));

    expect(inputs).toHaveLength(1);
    expect(inputs[0].keyPdf).toBeNull();
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

  describe("section edits during the AI call", () => {
    const FORM: Omit<AssignmentFormInput, "sectionsText"> = {
      title: "Unit 4 Quiz", instructions: "", gradingMode: "completion", accuracyWeight: 50, maxSubmissions: 500,
    };

    async function sectionedPaper(sectionsText: string, wrote: string) {
      const sectioned = seedAssignment(seedTeacher().id, { status: "open" });
      updateAssignment(sectioned, { ...FORM, sectionsText });
      seedApprovedKey(sectioned.id, [{ label: "1" }]);
      const { receiptUrl } = await ingestStudentUpload(sectioned.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1, { label: wrote }) }]);
      const id = getSubmissionByReceipt(receiptUrl.slice("/r/".length))!.id;
      const run = await startGatedAnswer((refs) => makeGradingOutput(refs, { student: { section_raw: wrote, section_match: null } }));
      return { sectioned, id, run };
    }

    it("files the paper under a section the teacher added while it was being graded", async () => {
      const { sectioned, id, run } = await sectionedPaper("Period 3", "Period 4");
      updateAssignment(sectioned, { ...FORM, sectionsText: "Period 3\nPeriod 4" });
      await run.finish();

      const period4 = listSections(sectioned.id).find((section) => section.label === "Period 4")!;
      expect(getSubmission(id)).toMatchObject({ status: "graded", sectionId: period4.id, sectionSource: "ai", flags: [] });
    });

    it("files the paper under a section whose label was corrected while it was being graded", async () => {
      const { sectioned, id, run } = await sectionedPaper("Peroid 3\nPeriod 4", "Period 3");
      updateAssignment(sectioned, { ...FORM, sectionsText: "Period 3\nPeriod 4" });
      await run.finish();

      const period3 = listSections(sectioned.id).find((section) => section.label === "Period 3")!;
      expect(getSubmission(id)).toMatchObject({ status: "graded", sectionId: period3.id, flags: [] });
    });
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
    // Question 3's 2 points are stated only for the whole question and are split across 3a and 3b.
    expect(listKeyItems(draft.id).map((item) => item.pointsCenti)).toEqual([100, 200, 100, 100, 200, 300]);
    expect(listKeyItems(draft.id)[2].aiNote).toBe("Split from question 3's 2 points.");
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

  it("retries a key refusal whose fallback model was unavailable, and fails the key once attempts run out", async () => {
    const refusal = new AiError("refusal", "declined", { retryable: true, refusalCategory: null });
    const worker = workerWith(scriptedGrader({ extractKey: () => Promise.reject(refusal) }));

    for (let attempt = 1; attempt < 4; attempt++) {
      expect(await worker.runOnce()).toBe(true);
      const [job] = jobRows(draft.id);
      expect(job).toMatchObject({ status: "queued", attempts: attempt, last_error: "refusal: declined" });
      expect(getKey(draft.id)).toMatchObject({ status: "processing", errorMessage: null });
      clock = job.run_after;
    }

    expect(await worker.runOnce()).toBe(true);
    expect(getKey(draft.id)).toMatchObject({
      status: "failed", errorMessage: "The AI declined to read this document. Build the key manually.",
    });
    expect(jobRows(draft.id)).toMatchObject([{ status: "failed", attempts: 4 }]);
  });

  it("detaches a student's paper uploaded as the key, so grading never sends it as the teacher's reference", async () => {
    const file = path.join(getConfig().dataDir, getKey(draft.id)!.sourcePdfPath!);
    expect(fs.existsSync(file)).toBe(true);
    await drainQueue(scriptedGrader({
      async extractKey(input, options) {
        const result = await instantFake.extractKey(input, options);
        return { ...result, output: { ...result.output, document_kind: "student_work" } };
      },
    }));

    expect(getKey(draft.id)).toMatchObject({
      status: "failed", documentKind: "student_work", sourcePdfPath: null, sourceFilename: null, sourceSha256: null, sourcePageCount: null,
      errorMessage: expect.stringContaining("student's paper"),
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(getAssignmentUsage(draft.id)).toMatchObject({ fake: { calls: 1 } });

    // The teacher builds the key by hand; papers are then graded without any key PDF.
    saveKey(draft, {
      teacherNotes: "", acknowledgeAiProposed: false,
      items: [{
        id: null, label: "1", groupLabel: "", prompt: "", answerType: "short_answer", expectedAnswer: "4", acceptableAnswers: [],
        gradingCriteria: "", pointsCenti: 100, partialCredit: true, page: null,
      }],
    }, { open: true });
    const { receiptUrl } = await ingestStudentUpload(draft.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1, { label: "ana" }) }]);
    const inputs: GradeInput[] = [];
    await drainQueue(recordingGrader(inputs));

    expect(inputs.map((input) => input.keyPdf)).toEqual([null]);
    expect(getSubmissionByReceipt(receiptUrl.slice("/r/".length))!.status).toBe("graded");
  });

  it("keeps the PDF of a key that was read but had no questions, so it can be read again", async () => {
    await drainQueue(scriptedGrader({
      async extractKey(input, options) {
        const result = await instantFake.extractKey(input, options);
        return { ...result, output: { ...result.output, items: [] } };
      },
    }));

    expect(getKey(draft.id)).toMatchObject({ status: "failed", sourcePdfPath: expect.any(String), documentKind: "answer_key" });
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
    expect(getWorkerStatus()).toEqual({
      state: "paused", reason: "No Anthropic API key. Add one in Settings.", aiMode: "claude", queued: 4, running: 0, keyIssue: "missing",
    });
  });

  it("runs jobs a pause pushed back at once, since a restart is how an ANTHROPIC_API_KEY fix arrives", async () => {
    setGraderForTests(null);
    const paused = seedSubmission(assignment.id);
    enqueueGrade(paused.id, assignment.id, PRIORITY.student);
    const job = claimNextJob(clock)!;
    jobsRepo.requeueJob(job.id, { runAfter: clock + 300_000, error: "paused", refundAttempt: true, paused: true });
    const backedOff = seedSubmission(assignment.id);
    enqueueGrade(backedOff.id, assignment.id, PRIORITY.student);
    const other = claimNextJob(clock)!;
    jobsRepo.requeueJob(other.id, { runAfter: clock + 30_000, error: "overloaded" });

    vi.spyOn(console, "info").mockImplementation(() => {});
    await startWorker();

    expect(jobRows(paused.id)).toMatchObject([{ status: "queued", run_after: clock, paused: 0 }]);
    expect(jobRows(backedOff.id)).toMatchObject([{ status: "queued", run_after: clock + 30_000, paused: 0 }]);
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

describe("API key changes", () => {
  function authError(): AiError {
    return new AiError("auth", "invalid x-api-key", { retryable: false, pauseWorker: true });
  }

  it("asks for the grader on every tick: paused without a key, then grading once a key is saved, without a restart", async () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    const id = await uploadPaper();
    const worker = createWorker({ grader: getGrader, concurrency: 1, pollMs: 1000 });
    worker.start();

    expect(worker.status()).toMatchObject({
      state: "paused", reason: "No Anthropic API key. Add one in Settings.", aiMode: "claude", keyIssue: "missing", queued: 1,
    });
    expect(await worker.runOnce()).toBe(false);

    // What saving a key amounts to for the worker: getGrader() has a grader from now on.
    setGraderForTests(instantFake);
    worker.kick();
    await vi.waitFor(() => expect(["graded", "needs_review"]).toContain(getSubmission(id)!.status));
    expect(worker.status()).toMatchObject({ state: "running", aiMode: "fake", keyIssue: null });
    await worker.stop();
  });

  it("reports a rejected key, and resumeWorker() runs the job the pause deferred at once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectKey = true;
    setGraderForTests(scriptedGrader({
      gradeSubmission: async (input, options) => {
        if (rejectKey) throw authError();
        return instantFake.gradeSubmission(input, options);
      },
    }));
    const id = await uploadPaper();
    await startWorker();

    await vi.waitFor(() => expect(getWorkerStatus()).toMatchObject({ state: "paused", keyIssue: "rejected" }));
    expect(jobRows(id)).toMatchObject([{ status: "queued", attempts: 0, run_after: T0 + 300_000, paused: 1 }]);

    rejectKey = false;
    resumeWorker();

    await vi.waitFor(() => expect(["graded", "needs_review"]).toContain(getSubmission(id)!.status));
    expect(getWorkerStatus()).toMatchObject({ state: "running", reason: null, keyIssue: null });
  });

  it("does not report the key for other pauses, and resume() leaves ordinary backoffs alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const billing = await uploadPaper("billing");
    const worker = workerWith(rejectingGrader(new AiError("billing", "credit balance is too low", { retryable: false, pauseWorker: true })));
    await worker.runOnce();
    worker.start();
    expect(worker.status()).toMatchObject({ state: "paused", keyIssue: null });
    const backedOff = await uploadPaper("backoff");
    jobsRepo.requeueJob(claimNextJob(clock)!.id, { runAfter: clock + 30_000, error: "overloaded" });

    worker.resume();

    expect(worker.status()).toMatchObject({ state: "running", reason: null });
    expect(jobRows(billing)).toMatchObject([{ run_after: T0, paused: 0 }]);
    expect(jobRows(backedOff)).toMatchObject([{ status: "queued", run_after: T0 + 30_000, paused: 0 }]);
    await worker.stop();
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

  it("puts back a job whose outcome could not be recorded, so a regrade is not blocked until a restart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const id = await uploadPaper();
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    vi.spyOn(jobsRepo, "completeJob").mockImplementationOnce(() => {
      throw busy;
    });
    const worker = workerWith(answeringGrader((refs) => makeGradingOutput(refs)));

    expect(await worker.runOnce()).toBe(true);
    expect(getSubmission(id)!.status).toBe("graded");
    expect(jobRows(id)).toMatchObject([{ status: "running" }]);

    regradeSubmission(getSubmission(id)!);
    expect(await worker.runOnce()).toBe(false); // the stuck running row blocks the regrade's job

    expect(worker.recoverOrphans()).toBe(1);
    expect(jobRows(id).map((job) => job.status)).toEqual(["cancelled", "queued"]);
    expect(await worker.runOnce()).toBe(true);
    expect(getSubmission(id)).toMatchObject({ status: "graded", gradingGeneration: 2 });
  });

  it("leaves the jobs it is running alone when putting back orphans", async () => {
    const id = await uploadPaper();
    const { grader, calls } = hangingGrader();
    const worker = workerWith(grader);

    worker.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(worker.inFlightJobIds()).toEqual([jobRows(id)[0].id]);
    expect(worker.recoverOrphans()).toBe(0);
    expect(jobRows(id)).toMatchObject([{ status: "running" }]);
    calls[0]();
    await vi.waitFor(() => expect(jobRows(id)).toMatchObject([{ status: "done" }]));
    await worker.stop();
  });

  it("schedules the recovery itself after failing to record an outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const id = await uploadPaper();
    vi.spyOn(jobsRepo, "completeJob").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    const worker = workerWith(answeringGrader((refs) => makeGradingOutput(refs)));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      worker.start();
      await vi.waitFor(() => expect(getSubmission(id)!.status).toBe("graded"));
      expect(jobRows(id)).toMatchObject([{ status: "running" }]);
      vi.advanceTimersByTime(30_000);
      // Requeued, then claimed again by the running worker; the handler sees a graded paper and is done.
      await vi.waitFor(() => expect(jobRows(id)).toMatchObject([{ status: "done", attempts: 2 }]));
    } finally {
      vi.useRealTimers();
      await worker.stop();
    }
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
