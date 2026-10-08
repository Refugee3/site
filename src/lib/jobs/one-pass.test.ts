import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { createFakeGrader } from "@/lib/ai/fake";
import type { Grader, PacketChunkInput } from "@/lib/ai/grader";
import type { PacketOutput, PacketPaper } from "@/lib/ai/schemas";
import { setClockForTests } from "@/lib/clock";
import { resetConfigForTests } from "@/lib/config";
import { getAssignmentUsage, getGradingBatchStartedAt } from "@/lib/db/repos/assignments";
import { getScan } from "@/lib/db/repos/scans";
import { setGradingEngine } from "@/lib/db/repos/settings";
import { listItems, listSubmissions } from "@/lib/db/repos/submissions";
import { BOUNDARY_NOTES } from "@/lib/grading/packet";
import { enqueueSplitScan } from "@/lib/jobs/queue";
import { drainQueue, FAKE_META, jobRows, scriptedGrader } from "@/lib/jobs/test-utils";
import { createWorker } from "@/lib/jobs/worker";
import { getGradingProgress } from "@/lib/services/progress";
import { ingestScan, retryScanWithAi, splitScanEvery } from "@/lib/services/scans";
import { regradeSubmission } from "@/lib/services/submissions";
import { getScanReviewView } from "@/lib/services/views";
import * as files from "@/lib/storage/files";
import type { Assignment, KeyItem, Scan, Submission } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedScan, seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
let clock = T0;
let assignment: Assignment;
let items: KeyItem[];

beforeEach(() => {
  clock = T0;
  setClockForTests(() => clock);
  useTestDb();
  assignment = seedAssignment(seedTeacher().id);
  // A three-page worksheet (k = 3): the fake grader finds a paper every three pages.
  items = seedApprovedKey(assignment.id, [{ label: "1", page: 1 }, { label: "2", page: 2 }, { label: "3", page: 3 }]);
});

const instantFake = createFakeGrader({ delayMs: 0 });

async function queuedPacket(pages: number): Promise<Scan> {
  const scan = await seedScan(assignment.id, { pages, splitMode: "one_pass" });
  enqueueSplitScan(scan.id, assignment.id);
  return scan;
}

/** ONE_PASS_CHUNK_PAGES for this test. */
function chunkPages(n: number): void {
  vi.stubEnv("ONE_PASS_CHUNK_PAGES", String(n));
  resetConfigForTests();
}

type Answer = (input: PacketChunkInput, call: number) => PacketOutput | AiError | null;

/** Records every chunk it is sent; `answer` may script the output (or an error to throw); null = the fake grader's answer. */
function packetGrader(calls: PacketChunkInput[], answer: Answer = () => null): Grader {
  return scriptedGrader({
    async gradePacketChunk(input, options) {
      calls.push(input);
      const scripted = answer(input, calls.length);
      if (scripted instanceof AiError) throw scripted;
      if (scripted) return { output: scripted, refs: items.map((_, i) => `Q${i + 1}`), keyPdfIncluded: false, meta: FAKE_META };
      return instantFake.gradePacketChunk!(input, options);
    },
  });
}

/** A paper on chunk pages first..last, every item answered correctly on its first page. */
function paper(first: number, last: number, o: Partial<PacketPaper> = {}): PacketPaper {
  return {
    first_page: first, last_page: last, continues_from_previous_chunk: false, may_continue_after_chunk: false,
    boundary_confidence: "high",
    student: { name: `Student ${"ABCDEFGHIJ"[first - 1]}`, name_confidence: "high", section_raw: null, section_match: null,
      multiple_students_detected: false },
    document_check: { match: "matches", pages_appear_missing: false, note: "" },
    items: items.map((_, i) => ({
      ref: `Q${i + 1}`, pages: [first], student_answer: "4", legibility: "clear" as const, attempt: "complete" as const,
      correctness: "correct" as const, confidence: "high" as const, review_reason: "none" as const, what_student_did: "", feedback: "",
      teacher_note: "",
    })),
    integrity: { grader_directed_text_found: false, excerpt: "" },
    unmatched_work: "", overall_feedback: "", teacher_summary: "",
    ...o,
  };
}

function runOnce(grader: Grader): Promise<boolean> {
  return createWorker({ grader, concurrency: 1, pollMs: 1000 }).runOnce();
}

/** [original filename, pages, status] of the assignment's papers, oldest first. */
function papers(): Array<[string, number, Submission["status"]]> {
  return listSubmissions(assignment.id).map((s) => [s.originalFilename, s.pageCount, s.status]);
}

function temporaryError(): AiError {
  return new AiError("server_error", "temporary trouble", { retryable: true });
}

describe("grading a whole-class scan in one pass", () => {
  it("grades a 9-page packet of 3-page papers in one call, storing each paper graded with its pages", async () => {
    const scan = await queuedPacket(9);
    const calls: PacketChunkInput[] = [];

    // Only the scan's job: no paper is queued for grading on its own.
    expect(await drainQueue(packetGrader(calls))).toBe(1);

    expect(calls.map((c) => [c.firstPage, c.chunkPageCount, c.totalPages, c.keyPageCount])).toEqual([[1, 9, 9, 3]]);
    const stored = listSubmissions(assignment.id);
    expect(papers().map(([name, pages]) => [name, pages])).toEqual([
      ["scan.pdf (pages 1–3)", 3], ["scan.pdf (pages 4–6)", 3], ["scan.pdf (pages 7–9)", 3],
    ]);
    for (const s of stored) {
      expect(["graded", "needs_review"]).toContain(s.status);
      expect(s).toMatchObject({ source: "teacher", gradingGeneration: 1, gradedKeyRevision: 1, aiEngine: "fake", aiModel: "fake", gradedAt: T0 });
      expect(s.scoreMaxCenti).not.toBeNull();
      expect(listItems(s.id).every((item) => item.judgment !== null)).toBe(true);
      expect(jobRows(s.id)).toEqual([]);
      // Each item's pages are the paper's own (1–3), as for a paper uploaded on its own.
      expect(listItems(s.id).flatMap((item) => item.judgment!.pages).every((page) => page >= 1 && page <= 3)).toBe(true);
    }
    // Distinct students, so the board doesn't fold them as resubmissions.
    const named = stored.flatMap((s) => (s.nameKey === null ? [] : [s.nameKey]));
    expect(new Set(named).size).toBe(named.length);

    const done = getScan(scan.id)!;
    expect(done).toMatchObject({
      status: "done", splitMode: "one_pass", pagesRead: 9, createdCount: 3, duplicateCount: 0, statusNote: null, errorMessage: null,
      splitStartedAt: T0, splitFinishedAt: T0, aiModel: "fake",
    });
    expect(done.onePass).toMatchObject({ nextPage: 10, chunks: 1, pending: null, skipped: [], endedCleanly: true });
    expect(done.onePass!.papers.map((p) => [p.firstPage, p.lastPage, p.submissionId])).toEqual(stored.map((s, i) => [3 * i + 1, 3 * i + 3, s.id]));
    // One AI call in the assignment's usage.
    expect(getAssignmentUsage(assignment.id).fake.calls).toBe(1);
    expect(getScanReviewView(done, assignment).onePass).toEqual({ papersGraded: 3, duplicates: 0, flagged: 0, pagesDone: 9, skipped: [] });
    // The batch the papers counted in ended with the scan.
    expect(getGradingBatchStartedAt(assignment.id)).toBeNull();
  });

  it("chunks in whole papers and resumes after a failed chunk without grading the chunks before it again", async () => {
    chunkPages(4); // three-page papers: one per chunk
    const scan = await queuedPacket(9);
    const calls: PacketChunkInput[] = [];
    const grader = packetGrader(calls, (_input, call) => (call === 2 ? temporaryError() : null));

    await runOnce(grader);

    expect(calls.map((c) => [c.firstPage, c.chunkPageCount])).toEqual([[1, 3], [4, 3]]);
    expect(papers().map(([name]) => name)).toEqual(["scan.pdf (pages 1–3)"]);
    const first = listSubmissions(assignment.id)[0];
    const waiting = getScan(scan.id)!;
    expect(waiting).toMatchObject({ status: "splitting", pagesRead: 3, createdCount: 1, statusNote: "Retrying after a temporary AI error" });
    expect(waiting.onePass).toMatchObject({ nextPage: 4, chunks: 1, pending: null });
    const [job] = jobRows(scan.id);
    // The run graded a chunk, so it used no attempt.
    expect(job).toMatchObject({ status: "queued", attempts: 0 });

    // The board shows the papers graded so far and about how many the scan has left.
    expect(getGradingProgress(assignment.id)).toMatchObject({ done: 1, total: 3, queued: 0, onePass: { scans: 1, remainingPapers: 2 } });
    expect(getScanReviewView(waiting, assignment).splitProgress).toMatchObject({ pagesRead: 3, pageCount: 9, papersGraded: 1 });

    clock = job.run_after;
    await runOnce(grader);

    expect(calls.map((c) => c.firstPage)).toEqual([1, 4, 4, 7]);
    expect(papers().map(([name]) => name)).toEqual(["scan.pdf (pages 1–3)", "scan.pdf (pages 4–6)", "scan.pdf (pages 7–9)"]);
    expect(listSubmissions(assignment.id)[0]).toEqual(first);
    expect(getScan(scan.id)).toMatchObject({ status: "done", pagesRead: 9, createdCount: 3 });
    // The failed call wasn't billed; the three that answered were, once each.
    expect(getAssignmentUsage(assignment.id).fake.calls).toBe(3);
  });

  it("stores a chunk's answer before its papers, so a crash while storing them doesn't call the AI again", async () => {
    const scan = await queuedPacket(6);
    const calls: PacketChunkInput[] = [];
    const original = files.writeFileAtomic;
    let writes = 0;
    vi.spyOn(files, "writeFileAtomic").mockImplementation(async (rel, bytes) => {
      if (++writes === 2) throw new Error("disk full");
      return original(rel, bytes);
    });

    await runOnce(packetGrader(calls));

    // The first paper was stored; the second's file write failed and the worker put the job back.
    expect(calls).toHaveLength(1);
    expect(papers().map(([name]) => name)).toEqual(["scan.pdf (pages 1–3)"]);
    const crashed = getScan(scan.id)!;
    expect(crashed.status).toBe("splitting");
    expect(crashed.onePass!.pending).toMatchObject({ firstPage: 1, lastPage: 6, stored: 1 });
    const [job] = jobRows(scan.id);
    expect(job.status).toBe("queued");

    clock = job.run_after;
    await runOnce(packetGrader(calls));

    expect(calls).toHaveLength(1);
    expect(papers().map(([name]) => name)).toEqual(["scan.pdf (pages 1–3)", "scan.pdf (pages 4–6)"]);
    expect(getScan(scan.id)).toMatchObject({ status: "done", createdCount: 2, duplicateCount: 0 });
    expect(getAssignmentUsage(assignment.id).fake.calls).toBe(1);
  });

  it("reads a paper that may go on after its chunk again at the start of the next chunk", async () => {
    chunkPages(6);
    const scan = await queuedPacket(9);
    const calls: PacketChunkInput[] = [];
    await drainQueue(packetGrader(calls, (input) => (input.firstPage === 1
      ? { papers: [paper(1, 3), paper(4, 6, { may_continue_after_chunk: true })], skipped_pages: [] }
      : { papers: [paper(1, 3), paper(4, 6)], skipped_pages: [] })));

    expect(calls.map((c) => [c.firstPage, c.chunkPageCount])).toEqual([[1, 6], [4, 6]]);
    expect(papers()).toEqual([
      ["scan.pdf (pages 1–3)", 3, "graded"], ["scan.pdf (pages 4–6)", 3, "graded"], ["scan.pdf (pages 7–9)", 3, "graded"],
    ]);
    expect(getScan(scan.id)!.onePass).toMatchObject({ chunks: 2, nextPage: 10, endedCleanly: true });
    // Each paper's share of its call: the usage adds up per call, and every paper counts as graded by the AI.
    expect(listSubmissions(assignment.id).every((s) => s.usage !== null)).toBe(true);
  });

  it("flags papers whose boundaries the AI wasn't sure of, and reports pages left out", async () => {
    const scan = await queuedPacket(7);
    await drainQueue(packetGrader([], () => ({
      papers: [paper(1, 3, { boundary_confidence: "low" }), paper(5, 7)],
      skipped_pages: [{ page: 4, kind: "blank" }],
    })));

    const [unsure, sure] = listSubmissions(assignment.id);
    expect(unsure).toMatchObject({ status: "needs_review", flags: ["paper_boundary"] });
    expect(unsure.teacherSummary).toContain(BOUNDARY_NOTES.lowConfidence);
    expect(sure).toMatchObject({ status: "graded", flags: [], originalFilename: "scan.pdf (pages 5–7)" });
    const view = getScanReviewView(getScan(scan.id)!, assignment);
    expect(view.onePass).toEqual({ papersGraded: 2, duplicates: 0, flagged: 1, pagesDone: 7, skipped: [{ page: 4, reason: "blank" }] });

    // Regraded on its own, the paper is graded the usual way.
    regradeSubmission(unsure);
    expect(await drainQueue()).toBe(1);
    expect(listSubmissions(assignment.id)[0]).toMatchObject({ gradingGeneration: 2 });
    expect(["graded", "needs_review"]).toContain(listSubmissions(assignment.id)[0].status);
  });

  it("grades a paper on its own when the answer for it misses most items", async () => {
    await queuedPacket(6);
    expect(await drainQueue(packetGrader([], () => ({ papers: [paper(1, 3), paper(4, 6, { items: [] })], skipped_pages: [] })))).toBe(2);
    const [whole, regraded] = listSubmissions(assignment.id);
    expect(whole.status).toBe("graded");
    expect(jobRows(whole.id)).toEqual([]);
    expect(jobRows(regraded.id)).toMatchObject([{ kind: "grade_submission", status: "done" }]);
    expect(["graded", "needs_review"]).toContain(regraded.status);
  });

  it("skips papers whose pages are already in the assignment", async () => {
    const first = await queuedPacket(6);
    await drainQueue(packetGrader([]));
    // The same scan again: every paper is a duplicate.
    const again = await seedScan(assignment.id, { pages: 6, splitMode: "one_pass" });
    enqueueSplitScan(again.id, assignment.id);
    await drainQueue(packetGrader([]));

    expect(getScan(first.id)).toMatchObject({ createdCount: 2, duplicateCount: 0 });
    expect(getScan(again.id)).toMatchObject({ status: "done", createdCount: 0, duplicateCount: 2 });
    expect(listSubmissions(assignment.id)).toHaveLength(2);
  });

  it("fails the scan for the teacher when the AI keeps failing, keeps the papers graded so far, and grades the rest on retry", async () => {
    chunkPages(3);
    const scan = await queuedPacket(6);
    const refused = new AiError("refusal", "no", { retryable: false });
    await runOnce(packetGrader([], (input) => (input.firstPage === 4 ? refused : null)));

    const failed = getScan(scan.id)!;
    expect(failed).toMatchObject({ status: "failed", createdCount: 1 });
    expect(failed.errorMessage).toBe("The AI declined to grade part of this scan. The papers graded so far stay; try again to grade the rest.");
    // Splitting it another way would grade pages twice.
    expect(() => splitScanEvery(failed, 3)).toThrow(/already graded in one pass/);
    expect(() => retryScanWithAi(failed, { mode: "auto" })).toThrow(/already graded in one pass/);

    const resumed = retryScanWithAi(failed);
    expect(resumed).toMatchObject({ status: "splitting", splitMode: "one_pass", splitGeneration: 2, errorMessage: null });
    const calls: PacketChunkInput[] = [];
    await drainQueue(packetGrader(calls));
    expect(calls.map((c) => c.firstPage)).toEqual([4]);
    expect(getScan(scan.id)).toMatchObject({ status: "done", createdCount: 2 });
  });

  it("splits first, then grades each paper, on an engine that can't grade in one pass", async () => {
    const scan = await queuedPacket(6);
    // The split, then its two papers graded on their own.
    expect(await drainQueue(scriptedGrader({ gradePacketChunk: null }))).toBe(3);
    expect(getScan(scan.id)).toMatchObject({ status: "done", splitMode: "auto", autoGraded: true, createdCount: 2, onePass: null });
  });
});

describe("uploading a scan to grade in one pass", () => {
  it("queues its grading in one pass, or its split while the hosted agent grades", async () => {
    const upload = async (label: string) => ({ bytes: await makePdf(6, { label }), filename: `${label}.pdf` });
    const onePass = await ingestScan(assignment, await upload("a"), { mode: "one_pass", pagesPerPaper: null });
    expect(onePass).toMatchObject({ status: "splitting", splitMode: "one_pass" });
    expect(jobRows(onePass.id)).toMatchObject([{ kind: "split_scan", status: "queued" }]);

    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    setGradingEngine("agent");
    const split = await ingestScan(assignment, await upload("b"), { mode: "one_pass", pagesPerPaper: null });
    expect(split).toMatchObject({ status: "splitting", splitMode: "auto" });
  });
});
