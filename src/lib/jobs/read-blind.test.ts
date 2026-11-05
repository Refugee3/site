import { beforeEach, describe, expect, it } from "vitest";
import type { PacketReadInput, ReadInput } from "@/lib/ai/grader";
import type { PacketReadingOutput, ReadingItem, ReadingOutput } from "@/lib/ai/schemas";
import { setClockForTests } from "@/lib/clock";
import { getScan } from "@/lib/db/repos/scans";
import { getSubmission, listItems, listSubmissions } from "@/lib/db/repos/submissions";
import { enqueueSplitScan } from "@/lib/jobs/queue";
import { drainQueue, FAKE_META, scriptedGrader } from "@/lib/jobs/test-utils";
import { ingestTeacherUpload } from "@/lib/services/submissions";
import type { Assignment, KeyItem } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedScan, seedTeacher, useTestDb } from "@/test/helpers";

// Regression for "a student selected a wrong answer and it was marked correct, as if they had chosen the right one": papers
// are read without the answer key, then marked. Graded here through the real job queue, database and scoring, with a
// scripted reader (no AI).

const T0 = 1_700_000_000_000;
let assignment: Assignment;
let items: KeyItem[];

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
  // Graded on accuracy, so a wrong answer costs its points (completion would give them for any attempt).
  assignment = seedAssignment(seedTeacher().id, { gradingMode: "accuracy" });
  items = seedApprovedKey(assignment.id, [
    { label: "1", answerType: "multiple_choice", prompt: "Which gas do plants take in? A) oxygen B) nitrogen C) carbon dioxide",
      expectedAnswer: "C) KEY-SENTINEL", acceptableAnswers: ["C"], pointsCenti: 100 },
    { label: "2", answerType: "numeric", prompt: "Write one half as a decimal.", expectedAnswer: "0.5", pointsCenti: 100 },
  ]);
});

const readItem = (ref: string, answer: string, o: Partial<ReadingItem> = {}): ReadingItem => ({
  ref, pages: [1], student_answer: answer, marks_seen: "", legibility: "clear", attempt: "complete", reading_confidence: "high", ...o,
});

const reading = (q1: string, q2: string): ReadingOutput => ({
  student: { name: "Maria Lopez", name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false },
  document_check: { match: "matches", pages_appear_missing: false, note: "" },
  items: [readItem("Q1", q1, { marks_seen: `${q1} circled` }), readItem("Q2", q2)],
  integrity: { grader_directed_text_found: false, excerpt: "" },
  unmatched_work: "",
});

async function uploadPaper(): Promise<string> {
  const { submissionId } = await ingestTeacherUpload(assignment, [{ filename: "maria.pdf", bytes: await makePdf(1, { label: "maria" }) }]);
  return submissionId;
}

describe("a paper read without the key, then marked", () => {
  it("scores a wrong multiple-choice mark as wrong: key C, student B, read as B, stored as marked by the program", async () => {
    const id = await uploadPaper();
    const reads: ReadInput[] = [];
    let judgeCalls = 0;
    await drainQueue(scriptedGrader({
      async readSubmission(input) {
        reads.push(input);
        return { output: reading("B", "1/2"), meta: FAKE_META };
      },
      async judgeSubmission() {
        judgeCalls++;
        throw new Error("nothing should be left to the judge");
      },
    }));

    // New assignments write no notes, and both items were decided by the program: no judge call at all.
    expect(judgeCalls).toBe(0);
    const stored = listItems(id);
    expect(stored.map((r) => [r.judgment?.studentAnswer, r.judgment?.correctness, r.judgment?.judgedBy, r.judgment?.marksSeen])).toEqual([
      ["B", "incorrect", "program", "B circled"],
      ["1/2", "correct", "program", undefined],
    ]);
    expect(getSubmission(id)).toMatchObject({ status: "graded", scoreEarnedCenti: 100, scoreMaxCenti: 200 });

    // The reader was told the questions and their options, never the answers.
    const sent = JSON.stringify(reads);
    expect(sent).toContain("Which gas do plants take in?");
    for (const secret of ["KEY-SENTINEL", "0.5", "expectedAnswer", "acceptableAnswers"]) expect(sent).not.toContain(secret);
  });

  it("keeps the teacher's override above the program's mark", async () => {
    const { saveItemOverride } = await import("@/lib/services/submissions");
    const id = await uploadPaper();
    await drainQueue(scriptedGrader({ readSubmission: async () => ({ output: reading("B", "0.5"), meta: FAKE_META }) }));
    expect(getSubmission(id)!.scoreEarnedCenti).toBe(100);
    saveItemOverride(getSubmission(id)!, items[0].id, { pointsCenti: 100, feedback: null, reason: "B was erased; the C is the answer." });
    expect(getSubmission(id)!.scoreEarnedCenti).toBe(200);
    expect(listItems(id)[0].judgment).toMatchObject({ correctness: "incorrect", judgedBy: "program" });
  });
});

describe("a whole-class scan read in one pass without the key", () => {
  it("reads the chunk blind, then marks each paper: the wrong mark stays wrong", async () => {
    const scan = await seedScan(assignment.id, { pages: 2, splitMode: "one_pass" });
    enqueueSplitScan(scan.id, assignment.id);
    const sent: PacketReadInput[] = [];
    const paper = (first: number, q1: string) => ({
      first_page: first, last_page: first, continues_from_previous_chunk: false, may_continue_after_chunk: false,
      boundary_confidence: "high" as const, ...reading(q1, "0.5"),
    });
    await drainQueue(scriptedGrader({
      async readPacketChunk(input) {
        sent.push(input);
        const output: PacketReadingOutput = { papers: [paper(1, "B"), paper(2, "C")], skipped_pages: [] };
        return { output, meta: FAKE_META };
      },
    }));

    expect(getScan(scan.id)!.status).toBe("done");
    const json = JSON.stringify(sent);
    for (const secret of ["KEY-SENTINEL", "0.5", "expectedAnswer"]) expect(json).not.toContain(secret);
    const stored = listSubmissions(assignment.id).map((s) => listItems(s.id).map((r) => [r.judgment?.studentAnswer, r.judgment?.correctness, r.judgment?.judgedBy]));
    expect(stored).toEqual([
      [["B", "incorrect", "program"], ["0.5", "correct", "program"]],
      [["C", "correct", "program"], ["0.5", "correct", "program"]],
    ]);
  });
});
