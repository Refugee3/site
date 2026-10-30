import { describe, expect, it, vi } from "vitest";
import { AiError } from "./errors";
import type {
  AiCallMeta, AnswerSpots, DetectedSpot, GradeInput, Grader, JudgeInput, PacketChunkInput, PacketReadInput, ReadInput, SpotDetection,
  TranscribeInput,
} from "./grader";
import { combineGrading, gradeByReading, gradePacketByReading, needsJudge, planMarks } from "./read-then-mark";
import type { JudgingOutput, PacketReadingOutput, ReadingItem, ReadingOutput } from "./schemas";
import { makeKeyItem, makeSection } from "./test-utils";

// The orchestration every engine uses, with a scripted reader and judge: no AI, no network.

const META = (inputTokens: number, o: Partial<AiCallMeta> = {}): AiCallMeta => ({
  requestedModel: "m", servedModel: "m", fallbackUsed: false, stopReason: "end_turn",
  usage: { inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 1, ...o,
});

const mcC = makeKeyItem({
  id: "mc", label: "1", answerType: "multiple_choice", prompt: "Which gas? A) oxygen B) nitrogen C) carbon dioxide",
  expectedAnswer: "C) EXPECTED-SENTINEL", acceptableAnswers: ["C"],
});
const essay = makeKeyItem({ id: "essay", label: "2", position: 1, answerType: "long_answer", expectedAnswer: "Chlorophyll reflects green light." });

function gradeInput(o: Partial<GradeInput> = {}): GradeInput {
  return {
    assignment: { title: "Plants", instructions: "" }, teacherNotes: "", sections: [makeSection()], items: [mcC, essay],
    studentPdf: new Uint8Array([1, 2, 3]), studentPageCount: 1, writeNotes: false, ...o,
  };
}

const readItem = (ref: string, answer: string, o: Partial<ReadingItem> = {}): ReadingItem => ({
  ref, pages: [1], student_answer: answer, marks_seen: "", legibility: "clear", attempt: "complete", reading_confidence: "high", ...o,
});

const reading = (items: ReadingItem[]): ReadingOutput => ({
  student: { name: "Ana", name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false },
  document_check: { match: "matches", pages_appear_missing: false, note: "" },
  items,
  integrity: { grader_directed_text_found: false, excerpt: "" },
  unmatched_work: "",
});

/** A scripted engine: reads `read`, and judges every item it is asked as `verdict` (recording what it was sent). */
function scripted(read: ReadingOutput, verdict: JudgingOutput["items"][number]["correctness"] = "correct") {
  const reads: ReadInput[] = [];
  const judged: JudgeInput[] = [];
  const g: Pick<Grader, "readSubmission" | "judgeSubmission"> = {
    readSubmission: vi.fn(async (input: ReadInput) => {
      reads.push(input);
      return { output: read, meta: META(100) };
    }),
    judgeSubmission: vi.fn(async (input: JudgeInput) => {
      judged.push(input);
      const notes = input.writeNotes !== false;
      return {
        output: {
          items: input.reading.filter((r) => notes || r.mark === null).map((r) => ({
            ref: r.ref, attempt: r.item.attempt, correctness: verdict, confidence: "high" as const, review_reason: "none" as const,
            what_student_did: notes ? `You wrote ${r.item.student_answer}.` : "", feedback: notes ? "Keep going." : "", teacher_note: "",
          })),
          overall_feedback: notes ? "Nice effort." : "",
          teacher_summary: "",
        },
        meta: META(10),
      };
    }),
  };
  return { g, reads, judged };
}

describe("gradeByReading: the professor's case", () => {
  it("marks a wrong multiple-choice answer wrong: the key says C, the student marked B, the reading says B", async () => {
    const { g, reads, judged } = scripted(reading([readItem("Q1", "B", { marks_seen: "B circled" }), readItem("Q2", "Green light bounces off.")]));
    const { output, refs, meta } = await gradeByReading(g, gradeInput());

    expect(refs).toEqual(["Q1", "Q2"]);
    expect(output.items[0]).toEqual({
      ref: "Q1", pages: [1], student_answer: "B", marks_seen: "B circled", legibility: "clear", attempt: "complete",
      correctness: "incorrect", confidence: "high", review_reason: "none", what_student_did: "", feedback: "", teacher_note: "",
      judged_by: "program",
    });
    // The reader was never told the answer.
    const sentToReader = JSON.stringify(reads);
    for (const secret of ["EXPECTED-SENTINEL", "\"C\"", "Chlorophyll", "expectedAnswer", "acceptableAnswers"]) {
      expect(sentToReader).not.toContain(secret);
    }
    // The judge only got the essay; Q1 was the program's.
    expect(judged).toHaveLength(1);
    expect(judged[0].reading.map((r) => [r.ref, r.mark?.correctness ?? null])).toEqual([["Q1", "incorrect"], ["Q2", null]]);
    expect(output.items[1]).toMatchObject({ ref: "Q2", correctness: "correct", judged_by: "ai" });
    expect(meta.usage.inputTokens).toBe(110);
  });

  it("is the same whichever engine reads: the judge cannot turn the program's mark right", async () => {
    const { g } = scripted(reading([readItem("Q1", "B"), readItem("Q2", "x")]), "correct");
    const { output } = await gradeByReading(g, gradeInput({ writeNotes: true }));
    // With notes on the judge is asked about Q1 too (for its notes), says "correct", and is ignored.
    expect(output.items[0]).toMatchObject({ correctness: "incorrect", judged_by: "program", what_student_did: "You wrote B." });
    expect(output.overall_feedback).toBe("Nice effort.");
  });
});

describe("gradeByReading: when the judge is called", () => {
  it("skips the judge when the program marked every item and notes are off", async () => {
    const { g, judged } = scripted(reading([readItem("Q1", "C"), readItem("Q2", "", { attempt: "none", legibility: "no_writing", pages: [] })]));
    const { output, meta } = await gradeByReading(g, gradeInput());
    expect(judged).toHaveLength(0);
    expect(g.judgeSubmission).not.toHaveBeenCalled();
    expect(output.items.map((i) => [i.ref, i.correctness, i.judged_by])).toEqual([["Q1", "correct", "program"], ["Q2", "no_answer", "program"]]);
    expect(meta.usage.inputTokens).toBe(100);
  });

  it("calls the judge for the notes alone when notes are on and the program marked everything", async () => {
    const { g, judged } = scripted(reading([readItem("Q1", "C"), readItem("Q2", "", { attempt: "none", legibility: "no_writing" })]));
    const { output } = await gradeByReading(g, gradeInput({ writeNotes: true }));
    expect(judged).toHaveLength(1);
    expect(judged[0].reading.every((r) => r.mark !== null)).toBe(true);
    expect(output.items.map((i) => i.what_student_did)).toEqual(["You wrote C.", "You wrote ."]);
  });

  it("leaves an item the teacher ruled on to the judge, with the rulings", async () => {
    const lesson = {
      itemId: "mc", studentAnswer: "B", aiAttempt: "complete" as const, aiCorrectness: "incorrect" as const, teacherAttempt: "complete" as const,
      teacherCorrectness: "correct" as const, overrideCenti: null, exact: null, reason: "The question was ambiguous; B is fine too.",
      feedback: null, whatStudentDid: null,
    };
    const { g, judged } = scripted(reading([readItem("Q1", "B"), readItem("Q2", "x")]), "correct");
    const { output } = await gradeByReading(g, gradeInput({ guidance: { preferences: "", lessons: [lesson] } }));
    expect(judged[0].reading.map((r) => r.mark)).toEqual([null, null]);
    expect(judged[0].guidance?.lessons).toEqual([lesson]);
    expect(output.items[0]).toMatchObject({ correctness: "correct", judged_by: "ai" });
  });

  it("carries the reading's cost on an error from the judge", async () => {
    const { g } = scripted(reading([readItem("Q1", "B"), readItem("Q2", "x")]));
    g.judgeSubmission = async () => {
      throw new AiError("refusal", "declined", { retryable: false, billed: { servedModel: "m", usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
    };
    const err = await gradeByReading(g, gradeInput()).catch((e: unknown) => e as AiError);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: "refusal", o: { retryable: false, billed: { servedModel: "m", usage: { inputTokens: 105, outputTokens: 3 } } } });
  });
});

describe("combineGrading", () => {
  const plan = (r: ReadingOutput, items = [mcC, essay]) => planMarks({ items, teacherNotes: "", guidance: undefined }, ["Q1", "Q2"], r);

  it("never lets a judged item be surer than its reading, and sends a low-confidence reading to the teacher", () => {
    const r = reading([readItem("Q1", "B"), readItem("Q2", "something", { reading_confidence: "low" })]);
    const judged: JudgingOutput = {
      items: [{ ref: "Q2", attempt: "complete", correctness: "correct", confidence: "high", review_reason: "none", what_student_did: "", feedback: "", teacher_note: "" }],
      overall_feedback: "", teacher_summary: "",
    };
    const out = combineGrading(r, plan(r), judged, false);
    expect(out.items[1]).toMatchObject({ correctness: "correct", confidence: "low", review_reason: "ambiguous_reading", judged_by: "ai" });
  });

  it("leaves out an item the reader or the judge left out, so reconcile reports it", () => {
    const r = reading([readItem("Q1", "B")]);
    expect(plan(r).map((p) => p.ref)).toEqual(["Q1"]);
    const r2 = reading([readItem("Q1", "B"), readItem("Q2", "x")]);
    expect(combineGrading(r2, plan(r2), { items: [], overall_feedback: "", teacher_summary: "" }, false).items.map((i) => i.ref)).toEqual(["Q1"]);
  });

  it("takes the transcription, pages, legibility, identity and checks from the reading", () => {
    const r = { ...reading([readItem("Q1", "C", { pages: [2], legibility: "partly_illegible" })]), unmatched_work: "A doodle." };
    const out = combineGrading(r, plan(r), null, false);
    expect(out).toMatchObject({ student: r.student, document_check: r.document_check, integrity: r.integrity, unmatched_work: "A doodle." });
    expect(out.items[0]).toMatchObject({ pages: [2], legibility: "partly_illegible", student_answer: "C" });
  });

  it("asks for the judge only when something is left or notes are on", () => {
    const r = reading([readItem("Q1", "C")]);
    expect(needsJudge(plan(r), false)).toBe(false);
    expect(needsJudge(plan(r), true)).toBe(true);
    expect(needsJudge([], true)).toBe(false);
  });
});

describe("gradePacketByReading", () => {
  const chunkInput = (o: Partial<PacketChunkInput> = {}): PacketChunkInput => {
    const g = gradeInput({ teacherNotes: "TEACHER-NOTES-SENTINEL" });
    const rest = { assignment: g.assignment, teacherNotes: g.teacherNotes, sections: g.sections, items: g.items, writeNotes: g.writeNotes };
    return { ...rest, chunkPdf: new Uint8Array([9]), firstPage: 1, chunkPageCount: 4, totalPages: 4, keyPageCount: 2, ...o };
  };
  const paper = (first: number, answer: string) => ({
    first_page: first, last_page: first + 1, continues_from_previous_chunk: false, may_continue_after_chunk: false,
    boundary_confidence: "high" as const, ...reading([readItem("Q1", answer, { pages: [first] }), readItem("Q2", "words", { pages: [first + 1] })]),
  });

  it("reads the chunk without answers, then marks and judges each paper on its own", async () => {
    const chunk: PacketReadingOutput = { papers: [paper(1, "B"), paper(3, "C")], skipped_pages: [] };
    const sent: PacketReadInput[] = [];
    const { g, judged } = scripted(reading([]), "incorrect");
    const grader = {
      ...g,
      readPacketChunk: async (input: PacketReadInput) => {
        sent.push(input);
        return { output: chunk, meta: META(1000) };
      },
    };
    const { output, refs, meta } = await gradePacketByReading(grader, chunkInput());

    const json = JSON.stringify(sent);
    for (const secret of ["EXPECTED-SENTINEL", "Chlorophyll", "TEACHER-NOTES-SENTINEL", "\"C\"", "expectedAnswer"]) expect(json).not.toContain(secret);
    expect(refs).toEqual(["Q1", "Q2"]);
    expect(output.papers.map((p) => [p.first_page, p.items.map((i) => [i.correctness, i.judged_by, i.pages])])).toEqual([
      // The assignment's instructions can't make the B right (they don't widen what is accepted), so the program marks it.
      [1, [["incorrect", "program", [1]], ["incorrect", "ai", [2]]]],
      [3, [["correct", "program", [3]], ["incorrect", "ai", [4]]]],
    ]);
    expect(judged).toHaveLength(2);
    expect(meta.usage.inputTokens).toBe(1020);
  });

  it("fails the chunk, with the cost so far, when a paper's judge call fails", async () => {
    const { g } = scripted(reading([]));
    let calls = 0;
    const grader = {
      ...g,
      judgeSubmission: async () => {
        calls++;
        throw new AiError("overloaded", "busy", { retryable: true });
      },
      readPacketChunk: async () => ({ output: { papers: [paper(1, "B")], skipped_pages: [] }, meta: META(1000) }),
    };
    const err = await gradePacketByReading(grader, chunkInput()).catch((e: unknown) => e as AiError);
    expect(calls).toBe(1);
    expect(err).toMatchObject({ code: "overloaded", o: { billed: { usage: { inputTokens: 1000 } } } });
  });
});

describe("with a blank worksheet's answer spots", () => {
  const evidence = { kind: "choice" as const, page: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, map: { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 } };
  const choiceSpot = (ref: string, marked: string[]): DetectedSpot => ({
    ref, kind: "choice", values: ["A", "B", "C"], multi: false, evidence,
    choice: { marked, confidence: "high", review: "none", marksSeen: `${marked.join(", ")}: strong mark` },
  });
  const writtenSpot = (ref: string, written: boolean): DetectedSpot => ({
    ref, kind: "write_in", values: [], multi: false, evidence: { ...evidence, kind: "write_in" },
    written: { written, confidence: "high", marksSeen: written ? "ink in the answer spot" : "answer spot empty" },
    ...(written ? { crop: { png: new Uint8Array([7]), width: 10, height: 5 } } : {}),
  });
  const spots = (detect: (pages: number[]) => SpotDetection): AnswerSpots & { calls: number[][] } => {
    const calls: number[][] = [];
    return { refs: ["Q1", "Q2"], calls, read: async (_pdf, pages) => (calls.push(pages), detect(pages)) };
  };

  it("reads the choice from its marks, not the AI's reading, and the AI only reads page 1 when every item is covered", async () => {
    const { g, reads } = scripted(reading([]));
    const transcribed: TranscribeInput[] = [];
    const grader = {
      ...g,
      transcribeCrops: async (input: TranscribeInput) => {
        transcribed.push(input);
        return { output: { crops: [{ id: "Q2", text: "Green light bounces off.", confidence: "medium" as const }] }, meta: META(5) };
      },
    };
    const answerSpots = spots(() => ({ ok: true, items: [choiceSpot("Q1", ["C"]), writtenSpot("Q2", true)], identityPdf: new Uint8Array([1]) }));
    const { output, meta } = await gradeByReading(grader, gradeInput({ answerSpots, studentPageCount: 2 }));
    expect(answerSpots.calls).toEqual([[1, 2]]);
    expect(reads[0]).toMatchObject({ items: [], studentPageCount: 1, studentPdf: new Uint8Array([1]) });
    expect(transcribed[0].crops.map((c) => c.id)).toEqual(["Q2"]);
    expect(output.items[0]).toMatchObject({ student_answer: "C", correctness: "correct", judged_by: "program", spot: { marked: ["C"] } });
    expect(output.items[1]).toMatchObject({ student_answer: "Green light bounces off.", judged_by: "ai", spot: { kind: "write_in" } });
    expect(output.answer_spots).toEqual({ status: "used", note: "" });
    expect(meta.usage.inputTokens).toBe(100 + 5 + 10);
  });

  it("a blank spot is no answer without any AI call for it; uncovered items keep the AI's full reading", async () => {
    const { g, reads, judged } = scripted(reading([readItem("Q1", "B"), readItem("Q2", "Some words")]));
    const answerSpots = spots(() => ({ ok: true, items: [choiceSpot("Q1", [])], identityPdf: new Uint8Array([1]) }));
    const { output } = await gradeByReading(g, gradeInput({ answerSpots }));
    expect(reads[0].items).toHaveLength(2);
    expect(output.items.map((i) => [i.student_answer, i.correctness, i.judged_by])).toEqual([["", "no_answer", "program"], ["Some words", "correct", "ai"]]);
    expect(judged[0].reading.map((r) => r.ref)).toEqual(["Q1", "Q2"]);
  });

  it("a paper that can't be lined up is read by the AI entirely and says so", async () => {
    const { g, reads } = scripted(reading([readItem("Q1", "B"), readItem("Q2", "words")]));
    const answerSpots = spots(() => ({ ok: false, reason: "unaligned", note: "Couldn't line up this paper." }));
    const { output } = await gradeByReading(g, gradeInput({ answerSpots }));
    expect(reads[0].items).toHaveLength(2);
    expect(output.items[0]).toMatchObject({ student_answer: "B", correctness: "incorrect" });
    expect(output.items[0].spot).toBeUndefined();
    expect(output.answer_spots).toEqual({ status: "unaligned", note: "Couldn't line up this paper." });
  });

  it("one pass: each paper's spots are read on its own pages of the chunk", async () => {
    const chunkInput = (o: Partial<PacketChunkInput>): PacketChunkInput => {
      const base = gradeInput();
      return {
        assignment: base.assignment, teacherNotes: "", sections: base.sections, items: base.items, writeNotes: false,
        chunkPdf: new Uint8Array([9]), firstPage: 1, chunkPageCount: 4, totalPages: 4, keyPageCount: 2, ...o,
      };
    };
    const paper = (first: number) => ({
      first_page: first, last_page: first + 1, continues_from_previous_chunk: false, may_continue_after_chunk: false,
      boundary_confidence: "high" as const, ...reading([readItem("Q1", "B", { pages: [first] }), readItem("Q2", "words", { pages: [first + 1] })]),
    });
    const { g } = scripted(reading([]));
    const grader = { ...g, readPacketChunk: async () => ({ output: { papers: [paper(1), paper(3)], skipped_pages: [] }, meta: META(1000) }) };
    const answerSpots = spots((pages) => (pages[0] === 1
      ? { ok: true, items: [choiceSpot("Q1", ["C"])], identityPdf: new Uint8Array([1]) }
      : { ok: false, reason: "unaligned", note: "no" }));
    const { output } = await gradePacketByReading(grader, chunkInput({ answerSpots }));
    expect(answerSpots.calls).toEqual([[1, 2], [3, 4]]);
    expect(output.papers.map((p) => [p.items[0].student_answer, p.items[0].correctness, p.answer_spots?.status])).toEqual([
      ["C", "correct", "used"], ["B", "incorrect", "unaligned"],
    ]);
  });
});
