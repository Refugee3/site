import { describe, expect, it } from "vitest";
import { decideFailure } from "@/lib/jobs/backoff";
import type { Job } from "@/lib/types";
import { AiError } from "../errors";
import { blindItems, type GradeInput, type PacketChunkInput, type PacketReadInput, type ReadInput, type ReadScanInput } from "../grader";
import {
  extractionTask, KEY_EXTRACTION_SYSTEM_PROMPT, readingTask, renderGradingContext, renderReadingContext, SCAN_SPLIT_SYSTEM_PROMPT,
} from "../prompts";
import {
  type JudgingOutput, type KeyExtraction, KeyExtractionSchema, outputFormat, type ReadingOutput, type ScanPages, ScanPagesSchema,
} from "../schemas";
import { makeKeyItem, makeSection } from "../test-utils";
import { createOllamaClient, type FetchInit } from "./client";
import {
  type CompactPacket, CompactJudgingSchema, CompactJudgingWithoutNotesSchema, CompactPacketSchema, compactJudging, compactReading,
  CompactReadingSchema, judgeNumPredict, OLLAMA_JUDGING_SYSTEM_PROMPT, OLLAMA_JUDGING_WITHOUT_NOTES_SYSTEM_PROMPT,
  OLLAMA_PACKET_READING_SYSTEM_PROMPT, OLLAMA_READING_SYSTEM_PROMPT, packetNumPredict, readingNumPredict, scanNumPredict,
} from "./compact";
import { createOllamaGrader, OLLAMA_KEEP_ALIVE, type OllamaGraderConfig } from "./grader";
import type { PdfRenderer } from "./render";

// Ollama's HTTP API is a fake `fetch` here: nothing is sent anywhere, and no model runs. Pages are "rendered" by a fake
// renderer: a PDF's first byte is its page count, and page n's PNG is the bytes [tag, n].

const BASE_URL = "http://localhost:11434";
const MODEL = "qwen2.5vl:7b";

const CFG: OllamaGraderConfig = {
  model: MODEL, numCtx: 16_384, imageMaxEdge: 1600, pagesPerCall: 4, timeoutMs: 60_000, maxPages: 200, concurrency: 1,
};

const fakeRender: PdfRenderer = async (pdf) => Array.from({ length: pdf[0] }, (_, i) => ({
  png: new Uint8Array([pdf[1] ?? 0, i + 1]), width: 1236, height: 1600,
}));

/** A PDF of `pages` pages for fakeRender, tagged so its images can be told apart. */
const pdf = (pages: number, tag = 7) => new Uint8Array([pages, tag]);
const imageOf = (tag: number, page: number) => Buffer.from([tag, page]).toString("base64");

interface Sent {
  url: string;
  body: {
    model: string; stream: boolean; keep_alive: string; options: Record<string, unknown>; format: unknown;
    messages: Array<{ role: string; content: string; images?: string[] }>;
  };
}

type Reply = Response | Error | ((init: FetchInit) => Promise<Response>);

/** Answers each request with the next reply; records every request. */
function fakeOllama(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: FetchInit): Promise<Response> => {
    sent.push({ url, body: JSON.parse(init.body ?? "null") as Sent["body"] });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply scripted");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(init);
    return reply;
  };
  return { sent, fetch };
}

function answer(content: unknown, o: { prompt?: number; output?: number; doneReason?: string } = {}): Response {
  return Response.json({
    model: MODEL, created_at: "2026-10-21T00:00:00Z", message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
    done: true, done_reason: o.doneReason ?? "stop", prompt_eval_count: o.prompt ?? 1000, eval_count: o.output ?? 200,
  });
}

function graderWith(fetch: ReturnType<typeof fakeOllama>["fetch"], cfg: Partial<OllamaGraderConfig> = {}) {
  return createOllamaGrader({ client: createOllamaClient({ baseUrl: BASE_URL, fetch }), cfg: { ...CFG, ...cfg }, render: fakeRender });
}

const keyExtraction: KeyExtraction = {
  document_kind: "answer_key",
  items: [{
    label: "1", group_label: "", prompt: "Solve 3/x = 9/12.", answer_type: "numeric", expected_answer: "x = 4", acceptable_answers: ["4"],
    grading_criteria: "", points: 2, group_points: null, page: 1, answer_source: "key", confidence: "high", note: "",
  }],
  stated_total_points: 2,
  notes: "",
  questions_for_teacher: [],
  suggested_title: "Proportions",
};

const item = (ref: string, o: Partial<ReadingOutput["items"][number]> = {}): ReadingOutput["items"][number] => ({
  ref, pages: [1], student_answer: "x = 4", marks_seen: "", legibility: "clear", attempt: "complete", reading_confidence: "high", ...o,
});

const reading = (items: ReadingOutput["items"], o: Partial<ReadingOutput> = {}): ReadingOutput => ({
  student: { name: "Ana Diaz", name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false },
  document_check: { match: "matches", pages_appear_missing: false, note: "" },
  items,
  integrity: { grader_directed_text_found: false, excerpt: "" },
  unmatched_work: "",
  ...o,
});

const judged = (ref: string, o: Partial<JudgingOutput["items"][number]> = {}): JudgingOutput["items"][number] => ({
  ref, attempt: "complete", correctness: "correct", confidence: "high", review_reason: "none", what_student_did: "Solved it.",
  feedback: "Nice.", teacher_note: "", ...o,
});

function gradeInput(o: Partial<GradeInput> = {}): GradeInput {
  return {
    assignment: { title: "Unit 4 Quiz", instructions: "Show your work." },
    teacherNotes: "Units required.",
    sections: [makeSection({ label: "Period 3" })],
    items: [
      makeKeyItem({ label: "1", expectedAnswer: "x = 4", prompt: "Solve 3/x = 9/12." }),
      makeKeyItem({ id: "i2", label: "2", position: 1, expectedAnswer: "EXPECTED-SENTINEL", gradingCriteria: "CRITERIA-SENTINEL" }),
    ],
    studentPdf: pdf(2, 2),
    studentPageCount: 2,
    writeNotes: true,
    ...o,
  };
}

function readInput(o: Partial<GradeInput> = {}): ReadInput {
  const g = gradeInput(o);
  return { assignmentTitle: g.assignment.title, sections: g.sections, items: blindItems(g.items), studentPdf: g.studentPdf, studentPageCount: g.studentPageCount };
}

const job = (o: Partial<Job> = {}): Job => ({
  id: 1, kind: "grade_submission", targetId: "s1", assignmentId: "a1", status: "running", priority: 0, attempts: 1, maxAttempts: 4,
  runAfter: 0, maxTokens: null, lastError: null, createdAt: 0, updatedAt: 0, finishedAt: null, paused: false, ...o,
} as Job);

describe("createOllamaGrader: extractKey", () => {
  it("sends the key's pages as images with the extraction prompts, the JSON schema and the local-model options", async () => {
    const api = fakeOllama(answer(keyExtraction, { prompt: 3000, output: 400 }));
    const grader = graderWith(api.fetch);
    const { output, meta } = await grader.extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(2, 9), pageCount: 2 });

    expect(output).toEqual(keyExtraction);
    expect(grader).toMatchObject({ mode: "claude", engine: "ollama", parallel: 1 });
    // A whole-class scan is graded in one pass, as with the direct API.
    expect(grader.readPacketChunk).toBeTypeOf("function");
    expect(grader.gradePacketChunk).toBeTypeOf("function");
    expect(api.sent).toHaveLength(1);
    const [{ url, body }] = api.sent;
    expect(url).toBe(`${BASE_URL}/api/chat`);
    expect(body).toMatchObject({
      model: MODEL, stream: false, keep_alive: OLLAMA_KEEP_ALIVE, options: { num_ctx: 16_384, temperature: 0 },
      format: outputFormat(KeyExtractionSchema).schema,
    });
    // A key is read once per assignment, and its answer can be long: no output bound.
    expect(body.options).not.toHaveProperty("num_predict");
    expect(body.messages[0]).toEqual({ role: "system", content: KEY_EXTRACTION_SYSTEM_PROMPT });
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].images).toEqual([imageOf(9, 1), imageOf(9, 2)]);
    expect(body.messages[1].content).toContain("The ANSWER KEY is attached as 2 images, in page order");
    expect(body.messages[1].content).toContain(extractionTask("Quiz", "", 2));
    // Local calls are free: the ledger prices "ollama:" models at $0.
    expect(meta).toMatchObject({
      requestedModel: `ollama:${MODEL}`, servedModel: `ollama:${MODEL}`, fallbackUsed: false, stopReason: "end_turn",
      usage: { inputTokens: 3000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("reads a long key in page batches and merges the items in page order", async () => {
    const second: KeyExtraction = {
      ...keyExtraction, items: [{ ...keyExtraction.items[0], label: "2", page: 5 }], stated_total_points: null, suggested_title: null,
      questions_for_teacher: [{ id: "q1", kind: "points", item_label: "2", question: "Points?", suggested_answer: "1", choices: [] }],
    };
    const api = fakeOllama(answer(keyExtraction), answer(second));
    const { output, meta } = await graderWith(api.fetch).extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(5), pageCount: 5 });

    expect(api.sent.map((s) => s.body.messages[1].images?.length)).toEqual([4, 1]);
    expect(api.sent[1].body.messages[1].content).toContain("this message shows pages 5–5 as 1 image (image 1 is page 5)");
    expect(output.items.map((i) => i.label)).toEqual(["1", "2"]);
    expect(output).toMatchObject({ stated_total_points: 2, suggested_title: "Proportions" });
    expect(output.questions_for_teacher.map((q) => q.id)).toEqual(["b2-q1"]);
    expect(meta.usage.inputTokens).toBe(2000);
  });
});

describe("createOllamaGrader: an answer that isn't usable", () => {
  it("sends invalid JSON back once with what is wrong, then uses the corrected answer", async () => {
    const api = fakeOllama(answer("Sure! Here is the key: {"), answer(keyExtraction, { prompt: 50, output: 300 }));
    const { output, meta } = await graderWith(api.fetch).extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 1 });

    expect(output).toEqual(keyExtraction);
    expect(api.sent).toHaveLength(2);
    const retry = api.sent[1].body.messages;
    expect(retry.slice(0, 2)).toEqual(api.sent[0].body.messages);
    expect(retry[2]).toEqual({ role: "assistant", content: "Sure! Here is the key: {" });
    expect(retry[3].role).toBe("user");
    expect(retry[3].content).toContain("the answer was not valid JSON");
    expect(meta.usage).toMatchObject({ inputTokens: 1050, outputTokens: 500 });
  });

  it("accepts an answer in a ```json fence", async () => {
    const api = fakeOllama(answer(`\`\`\`json\n${JSON.stringify(keyExtraction)}\n\`\`\``));
    const { output } = await graderWith(api.fetch).extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 1 });
    expect(output).toEqual(keyExtraction);
  });

  it("names the schema problem in the retry, and fails retryably when the second answer is unusable too", async () => {
    const api = fakeOllama(answer({ ...keyExtraction, document_kind: "recipe" }), answer("[]"));
    const err = await graderWith(api.fetch)
      .extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 1 })
      .catch((e: unknown) => e);

    expect(api.sent[1].body.messages[3].content).toContain("does not match the schema at document_kind");
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: "invalid_output", o: { retryable: true, billed: { servedModel: `ollama:${MODEL}` } } });
  });

  it("fails without retrying when the answer ran out of room in the context", async () => {
    const api = fakeOllama(answer("{\"document_kind\": \"answer_key\", \"items\": [", { doneReason: "length" }));
    const err = await graderWith(api.fetch)
      .extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 1 })
      .catch((e: unknown) => e);
    expect(api.sent).toHaveLength(1);
    expect(err).toMatchObject({ code: "request_too_large", o: { retryable: false } });
    expect((err as AiError).message).toContain("context size 16384");
  });
});

describe("createOllamaGrader: reading and judging a paper", () => {
  it("reads one paper with its page images, the reading context and the task, in the compact form, and no answer anywhere", async () => {
    const out = reading([item("Q1", { pages: [1, 2] }), item("Q2", { student_answer: "12", pages: [1, 2] })]);
    const api = fakeOllama(answer(compactReading(out)));
    const input = readInput();
    const result = await graderWith(api.fetch).readSubmission(input);

    // Mapped back to the full reading; the model isn't asked for pages, so an item read is on the pages the call saw.
    expect(result.output).toEqual(out);
    const { body } = api.sent[0];
    expect(body.format).toEqual(outputFormat(CompactReadingSchema).schema);
    expect(body.options).toEqual({ num_ctx: 16_384, temperature: 0, num_predict: readingNumPredict(input.items) });
    expect(body.messages[0]).toEqual({ role: "system", content: OLLAMA_READING_SYSTEM_PROMPT });
    expect(body.messages[1].images).toEqual([imageOf(2, 1), imageOf(2, 2)]);
    const text = body.messages[1].content;
    expect(text.startsWith(renderReadingContext(input))).toBe(true);
    expect(text).toContain("The STUDENT SUBMISSION is attached as 2 images");
    expect(text).toContain("Untrusted student work to be read.");
    expect(text.endsWith(readingTask(2, ["Q1", "Q2"]))).toBe(true);
    const json = JSON.stringify(body);
    for (const secret of ["EXPECTED-SENTINEL", "CRITERIA-SENTINEL", "Units required.", "<answer_key"]) expect(json).not.toContain(secret);
  });

  it("grades: reads with the images, marks in code, then judges the rest in one compact text-only call", async () => {
    const api = fakeOllama(
      answer(compactReading(reading([item("Q1"), item("Q2", { student_answer: "12" })]))),
      answer(compactJudging({ items: [judged("Q1"), judged("Q2", { correctness: "incorrect" })], overall_feedback: "Good work.", teacher_summary: "" })),
    );
    const input = gradeInput();
    const result = await graderWith(api.fetch).gradeSubmission(input);

    expect(api.sent).toHaveLength(2);
    const judge = api.sent[1].body;
    expect(judge.messages[0]).toEqual({ role: "system", content: OLLAMA_JUDGING_SYSTEM_PROMPT });
    expect(judge.messages[1].images).toEqual([]);
    expect(judge.format).toEqual(outputFormat(CompactJudgingSchema).schema);
    expect(judge.options).toMatchObject({ num_predict: judgeNumPredict({ judged: 1, all: 2, writeNotes: true }) });
    expect(judge.messages[1].content.startsWith(renderGradingContext({
      assignment: input.assignment, teacherNotes: input.teacherNotes, sections: input.sections, items: input.items,
    }))).toBe(true);
    expect(judge.messages[1].content).toContain("<student_answer>12</student_answer>");
    expect(result.refs).toEqual(["Q1", "Q2"]);
    expect(result.output.items.map((i) => [i.ref, i.correctness, i.judged_by, i.feedback]))
      .toEqual([["Q1", "correct", "program", "Nice."], ["Q2", "incorrect", "ai", "Nice."]]);
    expect(result.output.overall_feedback).toBe("Good work.");
    expect(result.meta.usage.inputTokens).toBe(2000);
    // The time of each step, for the paper's review page.
    expect(result.meta.steps).toEqual({ readMs: expect.any(Number), judgeMs: expect.any(Number) });
  });

  it("asks the judge for only the items left to it, without notes, when notes are off", async () => {
    const api = fakeOllama(
      answer(compactReading(reading([item("Q1"), item("Q2", { student_answer: "12" })]))),
      answer({ i: [{ r: "Q2", t: "c", k: "incorrect", c: "h", w: "none" }] }),
    );
    const result = await graderWith(api.fetch).gradeSubmission(gradeInput({ writeNotes: false }));
    expect(api.sent[1].body.messages[0]).toEqual({ role: "system", content: OLLAMA_JUDGING_WITHOUT_NOTES_SYSTEM_PROMPT });
    expect(api.sent[1].body.format).toEqual(outputFormat(CompactJudgingWithoutNotesSchema).schema);
    expect(api.sent[1].body.options).toMatchObject({ num_predict: judgeNumPredict({ judged: 1, all: 2, writeNotes: false }) });
    expect(api.sent[1].body.messages[1].content).toContain("Return one items entry for each of them, in this order: Q2.");
    expect(result.output.items.map((i) => [i.ref, i.correctness, i.feedback])).toEqual([["Q1", "correct", ""], ["Q2", "incorrect", ""]]);
    expect(result.output.overall_feedback).toBe("");
  });

  it("makes no judge call when the program marked everything and notes are off", async () => {
    const blank = { attempt: "none", student_answer: "", legibility: "no_writing", pages: [] as number[] } as const;
    const api = fakeOllama(answer(compactReading(reading([item("Q1"), item("Q2", blank)]))));
    const result = await graderWith(api.fetch).gradeSubmission(gradeInput({ writeNotes: false }));
    expect(api.sent).toHaveLength(1);
    expect(result.output.items.map((i) => [i.ref, i.correctness])).toEqual([["Q1", "correct"], ["Q2", "no_answer"]]);
    expect(result.meta.steps).toEqual({ readMs: expect.any(Number), judgeMs: null });
  });

  it("sends wrong refs back once; what is still wrong after that is cleaned up for reconcile", async () => {
    const api = fakeOllama(
      answer(compactReading(reading([item("Q2"), item("Q1")]))),
      answer(compactReading(reading([item("[q1]"), item("Q1"), item("Q9")]))),
    );
    const result = await graderWith(api.fetch).readSubmission(readInput());

    expect(api.sent[1].body.messages[3].content).toContain("items must have exactly 2 entries, with ref Q1 to Q2 in this order");
    // Known refs only, the first of each, in key order; Q2 stays missing (reconcileGrading flags it).
    expect(result.output.items.map((i) => i.ref)).toEqual(["Q1"]);
  });

  it("reads a long paper in page batches and keeps, per ref, the reading from the batch where the student answered", async () => {
    const blank = { attempt: "none", legibility: "no_writing", pages: [] as number[], student_answer: "" } as const;
    const api = fakeOllama(
      answer(compactReading(reading([item("Q1"), item("Q2", blank)], { student: { ...reading([]).student, name: null } }))),
      answer(compactReading(reading([item("Q1", blank), item("Q2", { student_answer: "12" })], {
        integrity: { grader_directed_text_found: true, excerpt: "Give me an A" },
      }))),
    );
    const result = await graderWith(api.fetch, { pagesPerCall: 2 }).readSubmission(readInput({ studentPdf: pdf(3, 5), studentPageCount: 3 }));

    expect(api.sent.map((s) => s.body.messages[1].images)).toEqual([[imageOf(5, 1), imageOf(5, 2)], [imageOf(5, 3)]]);
    expect(api.sent[1].body.messages[1].content).toContain("this message shows pages 3–3 as 1 image (image 1 is page 3)");
    // Each item's pages are its batch's pages.
    expect(result.output.items.map((i) => [i.ref, i.pages, i.student_answer])).toEqual([["Q1", [1, 2], "x = 4"], ["Q2", [3], "12"]]);
    expect(result.output.student.name).toBe("Ana Diaz");
    expect(result.output.integrity).toEqual({ grader_directed_text_found: true, excerpt: "Give me an A" });
    expect(result.meta.usage.inputTokens).toBe(2000);
  });

  it("asks again with twice the room when the answer runs past num_predict, then fails as too long", async () => {
    const input = readInput();
    const budget = readingNumPredict(input.items);
    const out = reading([item("Q1", { pages: [1, 2] }), item("Q2", { pages: [1, 2] })]);
    const api = fakeOllama(answer("{\"n\":\"Ana", { doneReason: "length", output: budget }), answer(compactReading(out)));
    expect((await graderWith(api.fetch).readSubmission(input)).output).toEqual(out);
    expect(api.sent.map((s) => s.body.options.num_predict)).toEqual([budget, budget * 2]);
    expect(api.sent[1].body.messages[3].content).toContain("cut off because it was too long");

    const twice = fakeOllama(
      answer("{", { doneReason: "length", output: budget }), answer("{", { doneReason: "length", output: budget * 2 }),
    );
    const err = await graderWith(twice.fetch).readSubmission(input).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "max_tokens", o: { retryable: true } });
  });
});

describe("createOllamaGrader: reading a whole-class scan in one pass", () => {
  type CompactPaper = CompactPacket["p"][number];
  const paper = (f: number, e: number, name: string, o: Partial<CompactPaper> = {}): CompactPaper => ({
    f, e, cp: false, cn: false, b: "h", ...compactReading(reading([item("Q1"), item("Q2", { student_answer: "12" })])), n: name, ...o,
  });
  const packetRead = (o: Partial<PacketReadInput> = {}): PacketReadInput => {
    const g = gradeInput();
    return {
      assignmentTitle: g.assignment.title, sections: g.sections, items: blindItems(g.items), chunkPdf: pdf(6, 3), firstPage: 1,
      chunkPageCount: 6, totalPages: 6, keyPageCount: 2, ...o,
    };
  };

  it("reads the chunk blind in batches of whole papers, and returns its papers with their pages in the chunk", async () => {
    const api = fakeOllama(
      answer({ p: [paper(1, 2, "Ana")], sk: [] }),
      answer({ p: [paper(1, 2, "Ben")], sk: [] }),
      answer({ p: [paper(1, 1, "Cy")], sk: [{ p: 2, k: "blank" }] }),
    );
    const input = packetRead();
    // pagesPerCall 3 with 2-page papers: 2 pages (one paper) per call.
    const { output, meta } = await graderWith(api.fetch, { pagesPerCall: 3 }).readPacketChunk!(input);

    expect(api.sent.map((s) => s.body.messages[1].images)).toEqual([
      [imageOf(3, 1), imageOf(3, 2)], [imageOf(3, 3), imageOf(3, 4)], [imageOf(3, 5), imageOf(3, 6)],
    ]);
    const first = api.sent[0].body;
    expect(first.messages[0]).toEqual({ role: "system", content: OLLAMA_PACKET_READING_SYSTEM_PROMPT });
    expect(first.format).toEqual(outputFormat(CompactPacketSchema).schema);
    expect(first.options).toMatchObject({ num_predict: packetNumPredict(input.items, 2, 2) });
    expect(first.messages[1].content.startsWith(renderReadingContext(input))).toBe(true);
    expect(api.sent[1].body.messages[1].content).toContain("pages 3–4 of a 6-page scan");
    // No answer, criteria or teacher's notes in any request: the scan is read blind.
    const json = JSON.stringify(api.sent);
    for (const secret of ["EXPECTED-SENTINEL", "CRITERIA-SENTINEL", "Units required.", "<answer_key"]) expect(json).not.toContain(secret);

    expect(output.papers.map((p) => [p.first_page, p.last_page, p.student.name])).toEqual([[1, 2, "Ana"], [3, 4, "Ben"], [5, 5, "Cy"]]);
    expect(output.papers[1].items.map((i) => [i.ref, i.pages, i.student_answer])).toEqual([["Q1", [3, 4], "x = 4"], ["Q2", [3, 4], "12"]]);
    expect(output.skipped_pages).toEqual([{ page: 6, kind: "blank" }]);
    expect(meta.usage.inputTokens).toBe(3000);
  });

  it("reads a paper the batch cut off again with the next batch, and joins a paper longer than a batch with its rest", async () => {
    const api = fakeOllama(
      // Pages 1–3: Ana (1–2), then Ben starting on 3 who may go on: read again from page 3.
      answer({ p: [paper(1, 2, "Ana"), paper(3, 3, "Ben", { cn: true })], sk: [] }),
      // Pages 3–5: Ben fills the batch and may go on.
      answer({ p: [paper(1, 3, "Ben", { cn: true })], sk: [] }),
      // Page 6: the rest of Ben's paper.
      answer({ p: [paper(1, 1, "", { n: null, cp: true, i: [
        { r: "Q1", a: "", m: "", c: "h", t: "n", l: "n" }, { r: "Q2", a: "15", m: "", c: "m", t: "c", l: "c" },
      ] })], sk: [] }),
    );
    const { output } = await graderWith(api.fetch, { pagesPerCall: 3 }).readPacketChunk!(packetRead({ keyPageCount: null }));

    expect(api.sent.map((s) => s.body.messages[1].images?.length)).toEqual([3, 3, 1]);
    expect(api.sent[1].body.messages[1].content).toContain("pages 3–5 of a 6-page scan");
    expect(output.papers.map((p) => [p.first_page, p.last_page, p.student.name, p.boundary_confidence])).toEqual([
      [1, 2, "Ana", "high"], [3, 6, "Ben", "high"],
    ]);
    // Per item, the reading from the batch where Ben answered it.
    expect(output.papers[1].items.map((i) => [i.ref, i.student_answer, i.pages])).toEqual([["Q1", "x = 4", [3, 4, 5]], ["Q2", "12", [3, 4, 5]]]);
    expect(output.papers[1].may_continue_after_chunk).toBe(false);
  });

  it("grades the chunk in one pass: each paper marked in code and judged from its transcription", async () => {
    const api = fakeOllama(
      answer({ p: [paper(1, 2, "Ana"), paper(3, 4, "Ben")], sk: [] }),
      answer({ i: [{ r: "Q2", t: "c", k: "incorrect", c: "h", w: "none" }] }),
      answer({ i: [{ r: "Q2", t: "c", k: "correct", c: "h", w: "none" }] }),
    );
    const g = gradeInput({ writeNotes: false });
    const input: PacketChunkInput = {
      assignment: g.assignment, teacherNotes: g.teacherNotes, sections: g.sections, items: g.items, writeNotes: false,
      chunkPdf: pdf(4, 3), firstPage: 1, chunkPageCount: 4, totalPages: 4, keyPageCount: 2,
    };
    const result = await graderWith(api.fetch).gradePacketChunk!(input);

    expect(api.sent).toHaveLength(3);
    expect(api.sent[0].body.messages[1].images).toHaveLength(4);
    for (const judge of api.sent.slice(1)) expect(judge.body.messages[1].images).toEqual([]);
    expect(result.output.papers.map((p) => [p.first_page, p.student.name, p.items.map((i) => [i.correctness, i.judged_by])])).toEqual([
      [1, "Ana", [["correct", "program"], ["incorrect", "ai"]]],
      [3, "Ben", [["correct", "program"], ["correct", "ai"]]],
    ]);
    expect(result.output.papers[0].timing).toEqual({ readMs: expect.any(Number), judgeMs: expect.any(Number) });
  });

  it("sends a batch back once when a paper's pages or refs are wrong", async () => {
    const api = fakeOllama(
      answer({ p: [paper(1, 9, "Ana", { i: [] })], sk: [] }),
      answer({ p: [paper(1, 2, "Ana")], sk: [] }),
    );
    const { output } = await graderWith(api.fetch).readPacketChunk!(packetRead({ chunkPdf: pdf(2, 3), chunkPageCount: 2, totalPages: 2 }));
    const retry = api.sent[1].body.messages[3].content;
    expect(retry).toContain("papers entry 1: f and e must be pages from 1 to 2");
    expect(retry).toContain("papers entry 1: items must have exactly 2 entries");
    expect(output.papers.map((p) => [p.first_page, p.last_page])).toEqual([[1, 2]]);
  });
});

describe("createOllamaGrader: output bounds", () => {
  it("bounds the scan split's answer by its pages", async () => {
    const pages: ScanPages = {
      pages: [1, 2].map((n) => ({
        chunk_page: n, kind: "student_work", starts_new_paper: n === 1, student_name: null, section_raw: null, page_marker: null,
        worksheet_page: n, confidence: "high", note: "",
      })),
    };
    const api = fakeOllama(answer(pages));
    await graderWith(api.fetch).readScanPages({
      assignmentTitle: "Quiz", sections: [], items: [makeKeyItem()], keyPageCount: 2, chunkPdf: pdf(2, 4), firstPage: 1,
      chunkPageCount: 2, totalPages: 2, previousPage: null,
    });
    expect(api.sent[0].body.options).toEqual({ num_ctx: 16_384, temperature: 0, num_predict: scanNumPredict(2) });
  });

  it("never asks for more than the context holds", async () => {
    const api = fakeOllama(answer(compactReading(reading([item("Q1", { pages: [1, 2] }), item("Q2", { pages: [1, 2] })]))));
    await graderWith(api.fetch, { numCtx: 4096 }).readSubmission(readInput({
      items: Array.from({ length: 40 }, (_, i) => makeKeyItem({ id: `i${i}`, label: String(i + 1), position: i, answerType: "long_answer" })),
    })).catch(() => undefined);
    expect(api.sent[0].body.options.num_predict).toBe(4096);
  });
});

describe("createOllamaGrader: readScanPages", () => {
  const scanInput = (o: Partial<ReadScanInput> = {}): ReadScanInput => ({
    assignmentTitle: "Quiz", sections: [], items: [makeKeyItem()], keyPageCount: 2, chunkPdf: pdf(3, 4), firstPage: 21,
    chunkPageCount: 3, totalPages: 40, previousPage: null, ...o,
  });
  const pages = (n: number, name: string | null): ScanPages => ({
    pages: Array.from({ length: n }, (_, i) => ({
      chunk_page: i + 1, kind: "student_work", starts_new_paper: i === 0, student_name: i === 0 ? name : null, section_raw: null,
      page_marker: null, worksheet_page: i + 1, confidence: "high", note: "",
    })),
  });

  it("reads the chunk in page batches, renumbers the pages to the chunk, and tells each batch about the page before it", async () => {
    const api = fakeOllama(answer(pages(2, "Ana")), answer(pages(1, "Ben")));
    const { output } = await graderWith(api.fetch, { pagesPerCall: 2 }).readScanPages(scanInput());

    expect(api.sent[0].body.messages[0]).toEqual({ role: "system", content: SCAN_SPLIT_SYSTEM_PROMPT });
    expect(api.sent[0].body.format).toEqual(outputFormat(ScanPagesSchema).schema);
    expect(api.sent[0].body.messages[1].content).toContain("pages 21–22 of a 40-page scan");
    expect(api.sent[1].body.messages[1].content).toContain("page 23 of a 40-page scan");
    expect(api.sent[1].body.messages[1].content).toContain("Scan page 22, just before these pages, was read as: student_work, no name, worksheet page 2");
    expect(output.pages.map((p) => [p.chunk_page, p.student_name])).toEqual([[1, "Ana"], [2, null], [3, "Ben"]]);
  });
});

describe("createOllamaGrader: failures", () => {
  const extract = (fetch: ReturnType<typeof fakeOllama>["fetch"], cfg: Partial<OllamaGraderConfig> = {}, signal?: AbortSignal) =>
    graderWith(fetch, cfg).extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 1 }, { signal })
      .then(() => new AiError("unknown", "expected a failure", { retryable: false }), (e: unknown) => e as AiError);

  it("pauses grading with \"start Ollama\" when nothing listens at the address", async () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
    const err = await extract(fakeOllama(refused).fetch);
    expect(err).toMatchObject({ code: "connection", o: { pauseWorker: true } });
    expect(err.o.pauseReason).toContain(`Ollama isn't running at ${BASE_URL} — start Ollama`);
    // The job layer pauses the worker with that reason.
    const decision = decideFailure(job(), err, { now: 0, maxTokens: 64_000, maxTokensCeiling: 128_000 });
    expect(decision).toEqual({ action: "pause", resumeAt: 300_000, reason: err.o.pauseReason, code: "connection" });
  });

  it("pauses grading with the pull command when the model isn't downloaded", async () => {
    const err = await extract(fakeOllama(Response.json({ error: `model '${MODEL}' not found` }, { status: 404 })).fetch);
    expect(err).toMatchObject({ code: "model_not_found", o: { pauseWorker: true, retryable: false } });
    expect(err.o.pauseReason).toBe(`The model ${MODEL} isn't downloaded in Ollama. Run: ollama pull ${MODEL}`);
  });

  it("pauses grading when the model is too big for this computer", async () => {
    const err = await extract(fakeOllama(Response.json(
      { error: "model requires more system memory (21.0 GiB) than is available (7.6 GiB)" }, { status: 500 },
    )).fetch);
    expect(err).toMatchObject({ code: "server_error", o: { pauseWorker: true } });
    expect(err.o.pauseReason).toContain("Choose a smaller model in Settings → Grader");
  });

  it("retries (without pausing) a call that takes longer than OLLAMA_TIMEOUT_MS", async () => {
    const hang = (init: FetchInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const err = await extract(fakeOllama(hang).fetch, { timeoutMs: 30 });
    expect(err).toMatchObject({ code: "timeout", o: { retryable: true } });
    expect(err.o.pauseWorker).toBeUndefined();
    const decision = decideFailure(job(), err, { now: 0, maxTokens: 64_000, maxTokensCeiling: 128_000, rand: () => 0.5 });
    expect(decision).toMatchObject({ action: "requeue", refundAttempt: false });
  });

  it("reports a call stopped by the job as aborted", async () => {
    const abort = new AbortController();
    const hang = (init: FetchInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      abort.abort();
    });
    expect(await extract(fakeOllama(hang).fetch, {}, abort.signal)).toMatchObject({ code: "aborted", o: { retryable: true } });
  });

  it("slows down when Ollama's queue is full", async () => {
    const err = await extract(fakeOllama(Response.json({ error: "server busy, please try again.  maximum pending requests exceeded" }, { status: 503 })).fetch);
    expect(err).toMatchObject({ code: "overloaded", o: { retryable: true } });
  });
});

describe("createOllamaGrader: one call at a time", () => {
  it("sends at most `concurrency` calls to Ollama at once; the others wait their turn", async () => {
    let active = 0;
    let most = 0;
    const slow = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return answer(keyExtraction);
    };
    const api = fakeOllama(slow, slow, slow);
    const grader = graderWith(api.fetch, { concurrency: 1 });
    const input = { assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 1 };
    await Promise.all([grader.extractKey(input), grader.extractKey(input), grader.extractKey(input)]);
    expect(api.sent).toHaveLength(3);
    expect(most).toBe(1);
  });
});
