import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_CONTEXT, PDF_BYTE_BUDGET } from "../claude";
import { type AiCallMeta, blindItems, type GradeInput, type Grader, type ReadInput, type ReadScanInput } from "../grader";
import { renderReadingContext, renderScanContext } from "../prompts";
import type { JudgingOutput, KeyExtraction, ReadingOutput, ScanPages } from "../schemas";
import { makeKeyItem, makeSection } from "../test-utils";
import { type AgentRole, SUBMIT_TOOL } from "./definitions";
import { createAgentGrader } from "./grader";
import { agentExtractionTask, agentReadingTask, agentScanTask, SUBMIT_ACCEPTED } from "./prompts";
import { agentProcessSlot } from "./provision";
import { SWEEP_INTERVAL_MS } from "./session";
import { apiError, createFakeManagedAgents, events, type FakeSession, memoryStore, testAgentConfig } from "./test-fake";

const FP = "0123456789abcdef0123456789abcdef";
const START = Date.parse("2026-10-07T12:00:00Z");

const readingOutput = (refs: string[], answer = "x = 4"): ReadingOutput => ({
  student: { name: "Maria Lopez", name_confidence: "high", section_raw: "Per. 3", section_match: "Period 3", multiple_students_detected: false },
  document_check: { match: "matches", pages_appear_missing: false, note: "" },
  items: refs.map((ref) => ({
    ref, pages: [1], student_answer: answer, marks_seen: "", legibility: "clear", attempt: "complete", reading_confidence: "high",
  })),
  integrity: { grader_directed_text_found: false, excerpt: "" },
  unmatched_work: "",
});

const JUDGE_META: AiCallMeta = {
  requestedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5", fallbackUsed: false, stopReason: "end_turn",
  usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 5,
};

/** The direct engine's text-only judge, as the app wires it (index.ts); here it judges every item it is asked as incorrect. */
const judgeEverythingWrong: Grader["judgeSubmission"] = async (input) => ({
  output: {
    items: input.reading.filter((r) => input.writeNotes !== false || r.mark === null).map((r) => ({
      ref: r.ref, attempt: r.item.attempt, correctness: "incorrect", confidence: "high", review_reason: "none",
      what_student_did: "", feedback: "", teacher_note: "",
    })),
    overall_feedback: "",
    teacher_summary: "",
  } satisfies JudgingOutput,
  meta: JUDGE_META,
});

const keyExtraction: KeyExtraction = {
  document_kind: "answer_key",
  items: [{
    label: "1", group_label: "", prompt: "Solve 3/x = 9/12.", answer_type: "numeric", expected_answer: "x = 4", acceptable_answers: ["4"],
    grading_criteria: "", points: 2, group_points: null, graded: true, page: 1, answer_source: "key", confidence: "high", note: "",
  }],
  stated_total_points: 2,
  notes: "",
  questions_for_teacher: [],
  suggested_title: null,
};

const scanPages = (n: number): ScanPages => ({
  pages: Array.from({ length: n }, (_, i) => ({
    chunk_page: i + 1, kind: "student_work", starts_new_paper: i === 0, student_name: i === 0 ? "Ana" : null, section_raw: null,
    page_marker: null, worksheet_page: i + 1, confidence: "high", note: "",
  })),
});

const pdf = (tag: number, size = 64) => new Uint8Array(size).fill(tag);

function gradeInput(overrides: Partial<GradeInput> = {}): GradeInput {
  return {
    assignment: { title: "Unit 4 Quiz", instructions: "Show your work." },
    teacherNotes: "Units required.",
    sections: [makeSection({ label: "Period 3" })],
    items: [
      makeKeyItem({ label: "1", expectedAnswer: "EXPECTED-SENTINEL", acceptableAnswers: ["ACCEPTED-SENTINEL"] }),
      makeKeyItem({ id: "i2", label: "2", position: 1, gradingCriteria: "CRITERIA-SENTINEL" }),
    ],
    studentPdf: pdf(2),
    studentPageCount: 2,
    ...overrides,
  };
}

function readInput(overrides: Partial<GradeInput> = {}): ReadInput {
  const g = gradeInput(overrides);
  return { assignmentTitle: g.assignment.title, sections: g.sections, items: blindItems(g.items), studentPdf: g.studentPdf, studentPageCount: g.studentPageCount };
}

function scanInput(overrides: Partial<ReadScanInput> = {}): ReadScanInput {
  return {
    assignmentTitle: "Unit 4 Quiz", sections: [], items: [makeKeyItem()], keyPageCount: 2, chunkPdf: pdf(3),
    firstPage: 5, chunkPageCount: 3, totalPages: 12, previousPage: null, ...overrides,
  };
}

/** The agent submits the next of `outputs` for its role each time it is asked (initially, and after a rejection). */
function agentAnswering(outputs: Partial<Record<AgentRole, unknown[]>>, tools: Partial<Record<AgentRole, string>> = {}) {
  const given = new Map<string, number>();
  const submit = (s: FakeSession) => {
    const role = s.params.metadata?.role as AgentRole;
    const list = outputs[role] ?? [];
    const n = given.get(s.id) ?? 0;
    given.set(s.id, n + 1);
    s.emit(events.customToolUse(tools[role] ?? SUBMIT_TOOL[role], list[Math.min(n, list.length - 1)] as Record<string, unknown>));
  };
  return {
    onCreate: (s: FakeSession) => {
      s.usage = { input_tokens: 500, output_tokens: 80, list_cost: { amount: "17", currency: "USD" }, active_seconds: 30 };
      s.emit(events.running());
      submit(s);
    },
    onEvent: (s: FakeSession, e: BetaManagedAgentsEventParams) => {
      if (e.type !== "user.custom_tool_result") return;
      if (e.is_error) submit(s);
      else s.emit(events.idle("end_turn"));
    },
  };
}

function setup(
  outputs: Partial<Record<AgentRole, unknown[]>> = {},
  o: { keepSessions?: boolean; tools?: Partial<Record<AgentRole, string>> } = {},
) {
  const clock = { now: START };
  const fake = createFakeManagedAgents({ script: agentAnswering(outputs, o.tools) });
  const store = memoryStore();
  const onFirstSuccess = vi.fn();
  const judge = vi.fn(judgeEverythingWrong);
  const deps = {
    port: fake.port, store, cfg: testAgentConfig({ keepSessions: o.keepSessions ?? false }), keyFingerprint: () => FP,
    now: () => clock.now, onFirstSuccess, judge,
  };
  return { fake, store, clock, onFirstSuccess, judge, deps, grader: createAgentGrader(deps) };
}

const createBodies = (fake: ReturnType<typeof createFakeManagedAgents>) =>
  fake.calls.filter((c) => c.method === "createSession").map((c) => c.args[0] as SessionCreateParams);

function messageContent(body: SessionCreateParams) {
  const event = body.initial_events?.[0];
  if (event?.type !== "user.message") throw new Error("expected the initial user.message");
  return event.content;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAgentGrader", () => {
  it("is the hosted agent engine in claude mode", () => {
    const { grader } = setup();
    expect(grader.mode).toBe("claude");
    expect(grader.engine).toBe("agent");
  });

  it("reads a paper with the reading context, the student PDF and the task only: no answer key in the session", async () => {
    const { fake, grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    const input = readInput();
    const result = await grader.readSubmission(input);

    expect(result.output).toEqual(readingOutput(["Q1", "Q2"]));
    expect(fake.uploads.map((u) => u.name)).toEqual(["student-submission.pdf"]);
    const [body] = createBodies(fake);
    expect(body.title).toBe("PDF Auto-Grader: read one paper");
    expect(body.resources).toEqual([{ type: "file", file_id: "file_1", mount_path: "/student-submission.pdf" }]);
    expect(body.initial_events).toEqual([{
      type: "user.message",
      content: [
        { type: "text", text: renderReadingContext(input) },
        { type: "document", title: "STUDENT SUBMISSION", context: DOCUMENT_CONTEXT.student, source: { type: "file", file_id: "file_1" } },
        { type: "text", text: agentReadingTask(2, ["Q1", "Q2"]) },
      ],
    }]);
  });

  it("never puts an expected answer, criteria or the teacher's notes in the session, its files or the agent's definition", async () => {
    const { fake, grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    // A whole KeyItem passed by mistake still sends only the blind fields.
    const g = gradeInput({ guidance: { preferences: "PREFERENCE-SENTINEL", lessons: [] } });
    await grader.readSubmission({ assignmentTitle: g.assignment.title, sections: g.sections, items: g.items, studentPdf: g.studentPdf, studentPageCount: 2 });
    const gradeAgent = fake.calls.filter((c) => c.method === "createAgent"
      && (c.args[0] as { metadata?: Record<string, string> }).metadata?.role === "grade");
    expect(gradeAgent).toHaveLength(1);
    const sent = JSON.stringify([createBodies(fake), fake.uploads.map((u) => u.name), gradeAgent]);
    for (const secret of ["EXPECTED-SENTINEL", "ACCEPTED-SENTINEL", "CRITERIA-SENTINEL", "Units required.", "PREFERENCE-SENTINEL", "answer-key.pdf"]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("grades a paper: the agent reads it, the program marks it, and the text-only judge decides the rest", async () => {
    const { fake, grader, judge } = setup({ grade: [readingOutput(["Q1", "Q2"], "B")] });
    const input = gradeInput({
      teacherNotes: "",
      items: [
        makeKeyItem({ label: "1", answerType: "multiple_choice", prompt: "Pick: A) x B) y C) z", expectedAnswer: "C" }),
        makeKeyItem({ id: "i2", label: "2", position: 1, answerType: "long_answer", expectedAnswer: "Explain." }),
      ],
      writeNotes: false,
    });
    const result = await grader.gradeSubmission(input);

    expect(result.refs).toEqual(["Q1", "Q2"]);
    // The professor's case: the key says C, the student marked B, and B is what was read and marked wrong.
    expect(result.output.items.map((i) => [i.ref, i.student_answer, i.correctness, i.judged_by]))
      .toEqual([["Q1", "B", "incorrect", "program"], ["Q2", "B", "incorrect", "ai"]]);
    expect(judge).toHaveBeenCalledTimes(1);
    const judged = judge.mock.calls[0][0];
    expect(judged.reading.map((r) => [r.ref, r.item.student_answer, r.mark?.correctness ?? null])).toEqual([["Q1", "B", "incorrect"], ["Q2", "B", null]]);
    // One session (the reading); the judge is not a session.
    expect(createBodies(fake)).toHaveLength(1);
    expect(result.meta.usage).toEqual({ inputTokens: 540, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(result.meta.agent).toEqual({ listCostCents: 17, activeSeconds: 30 });
  });

  it("skips the judge when the program marked every item and notes are off", async () => {
    const { grader, judge } = setup({ grade: [readingOutput(["Q1", "Q2"], "C")] });
    const result = await grader.gradeSubmission(gradeInput({
      teacherNotes: "",
      writeNotes: false,
      items: [
        makeKeyItem({ label: "1", answerType: "multiple_choice", expectedAnswer: "C" }),
        makeKeyItem({ id: "i2", label: "2", position: 1, answerType: "multiple_choice", expectedAnswer: "B) photosynthesis" }),
      ],
    }));
    expect(judge).not.toHaveBeenCalled();
    expect(result.output.items.map((i) => i.correctness)).toEqual(["correct", "incorrect"]);
  });

  it("rejects a reading whose refs don't match the key, saying what is wrong", async () => {
    const wrong = readingOutput(["Q1", "Q9"]);
    const { fake, grader } = setup({ grade: [wrong, readingOutput(["Q1", "Q2"])] });
    const result = await grader.readSubmission(readInput());
    expect(result.output.items.map((i) => i.ref)).toEqual(["Q1", "Q2"]);
    const rejection = fake.sent().find((e) => e.type === "user.custom_tool_result" && e.is_error);
    expect(rejection).toMatchObject({ content: [{ type: "text", text: expect.stringContaining(
      "- items must have exactly 2 entries, with ref Q1 to Q2 in this order\n- missing: Q2\n- not in the key: Q9\n"
      + "- entry 2 has ref \"Q9\" where Q2 was expected") }] });
  });

  it("reads an answer key with its own agent", async () => {
    const { fake, grader } = setup({ extract: [keyExtraction] });
    const result = await grader.extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 2 });
    expect(result.output).toEqual(keyExtraction);
    const [body] = createBodies(fake);
    expect(body.title).toBe("PDF Auto-Grader: read an answer key");
    expect(body.agent).toEqual({ type: "agent", id: "agent_1", version: 1 });
    expect(body.metadata).toMatchObject({ role: "extract" });
    expect(body.budget).toEqual({ type: "limit", max_list_cost: { amount: "300", currency: "USD" } });
    expect(body.resources).toEqual([{ type: "file", file_id: "file_1", mount_path: "/answer-key.pdf" }]);
    expect(messageContent(body)).toEqual([
      { type: "document", title: "ANSWER KEY", source: { type: "file", file_id: "file_1" } },
      { type: "text", text: agentExtractionTask("Quiz", "", 2) },
    ]);
  });

  it("reads scanned pages with its own agent and checks the page count and order", async () => {
    const shuffled = scanPages(3);
    shuffled.pages[1].chunk_page = 3;
    const { fake, grader } = setup({ scan: [scanPages(2), shuffled, scanPages(3)] });
    const input = scanInput();
    const result = await grader.readScanPages(input);
    expect(result.output).toEqual(scanPages(3));
    const [body] = createBodies(fake);
    expect(body.title).toBe("PDF Auto-Grader: read scanned pages 5–7");
    expect(body.agent).toEqual({ type: "agent", id: "agent_3", version: 1 });
    expect(body.budget).toEqual({ type: "limit", max_list_cost: { amount: "150", currency: "USD" } });
    expect(body.resources).toEqual([{ type: "file", file_id: "file_1", mount_path: "/scanned-pages.pdf" }]);
    expect(messageContent(body)).toEqual([
      { type: "text", text: renderScanContext(input) },
      { type: "document", title: "SCANNED PAGES", context: DOCUMENT_CONTEXT.scan, source: { type: "file", file_id: "file_1" } },
      { type: "text", text: agentScanTask(5, 3, 12, null) },
    ]);
    const rejections = fake.sent().flatMap((e) => (e.type === "user.custom_tool_result" && e.is_error ? [e.content?.[0]] : []));
    expect(rejections).toEqual([
      { type: "text", text: expect.stringContaining("- pages must have exactly 3 entries, with chunk_page 1 to 3 in this order") },
      { type: "text", text: expect.stringContaining("- pages must have exactly 3 entries, with chunk_page 1 to 3 in this order\n"
        + "- entry 2 has chunk_page 3 where 2 was expected") },
    ]);
  });

  it("returns the session's usage and cost in the call's meta", async () => {
    const { grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    const { meta } = await grader.readSubmission(readInput());
    expect(meta).toEqual({
      requestedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5", fallbackUsed: false, stopReason: "end_turn",
      usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: expect.any(Number),
      agent: { listCostCents: 17, activeSeconds: 30 },
    });
  });

  it("reports keys and papers under the chosen model, and scans under Sonnet 5.5, the models their agents run on", async () => {
    const { grader } = setup({ extract: [keyExtraction], grade: [readingOutput(["Q1", "Q2"])], scan: [scanPages(3)] });
    const key = await grader.extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf(1), pageCount: 2 });
    const paper = await grader.readSubmission(readInput());
    const scan = await grader.readScanPages(scanInput());
    expect([key.meta, paper.meta, scan.meta].map((m) => [m.requestedModel, m.servedModel])).toEqual([
      ["claude-opus-5-5", "claude-opus-5-5"], ["claude-opus-5-5", "claude-opus-5-5"], ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ]);
  });

  it("reads the chosen model when each task starts, so a grader built before a change uses the new model too", async () => {
    const { fake, deps } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    let model: "claude-opus-5-5" | "claude-sonnet-5-5" = "claude-opus-5-5";
    const grader = createAgentGrader({ ...deps, currentModel: () => model });

    expect((await grader.readSubmission(readInput())).meta.servedModel).toBe("claude-opus-5-5");
    model = "claude-sonnet-5-5";
    const { meta } = await grader.readSubmission(readInput());

    expect(meta).toMatchObject({ requestedModel: "claude-sonnet-5-5", servedModel: "claude-sonnet-5-5" });
    // The grader agent was updated (same id, next version), and the second session runs on that version.
    expect(fake.calls.filter((c) => c.method === "updateAgent").map((c) => [c.args[0], (c.args[1] as { model: unknown }).model]))
      .toEqual([["agent_1", { id: "claude-sonnet-5-5", effort: "high" }], ["agent_2", { id: "claude-sonnet-5-5", effort: "high" }]]);
    expect(createBodies(fake).map((b) => b.agent)).toEqual([
      { type: "agent", id: "agent_2", version: 1 }, { type: "agent", id: "agent_2", version: 2 },
    ]);
    expect(fake.calls.filter((c) => c.method === "createAgent")).toHaveLength(3);
  });

  it("doubles the spending cap on the retry that asks for more than the configured max tokens", async () => {
    const { fake, grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    await grader.readSubmission(readInput(), { maxTokens: 64_000 });
    await grader.readSubmission(readInput(), { maxTokens: 128_000 });
    expect(createBodies(fake).map((b) => b.budget?.max_list_cost.amount)).toEqual(["200", "400"]);
  });

  it("refuses oversized PDFs before any network call, like the direct path", async () => {
    const { fake, grader } = setup();
    const huge = new Uint8Array(PDF_BYTE_BUDGET + 1);
    await expect(grader.extractKey({ assignmentTitle: "Q", teacherNotes: "", keyPdf: huge, pageCount: 1 }))
      .rejects.toMatchObject({ code: "request_too_large", message: "The answer key PDF is too large to send to the AI." });
    await expect(grader.readSubmission(readInput({ studentPdf: huge })))
      .rejects.toMatchObject({ code: "request_too_large", message: "The student's PDF is too large to send to the AI." });
    await expect(grader.readScanPages(scanInput({ chunkPdf: huge })))
      .rejects.toMatchObject({ code: "request_too_large", message: "These scanned pages are too large to send to the AI." });
    expect(fake.calls).toEqual([]);
  });

  it("calls onFirstSuccess once, after the first task that succeeds", async () => {
    const { fake, grader, onFirstSuccess } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    fake.fail("createSession", apiError(500));
    await expect(grader.readSubmission(readInput())).rejects.toMatchObject({ code: "server_error" });
    expect(onFirstSuccess).not.toHaveBeenCalled();
    await grader.readSubmission(readInput());
    await grader.readSubmission(readInput());
    expect(onFirstSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps the answer when onFirstSuccess throws", async () => {
    const { deps } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const grader = createAgentGrader({ ...deps, onFirstSuccess: () => { throw new Error("db locked"); } });
    await expect(grader.readSubmission(readInput())).resolves.toMatchObject({ output: { items: [{ ref: "Q1" }, { ref: "Q2" }] } });
    expect(consoleError).toHaveBeenCalled();
  });

  it("records a session-phase 403 in the store so Settings shows it, keeping the ids", async () => {
    const { fake, store, grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    fake.fail("createSession", apiError(403));
    await expect(grader.readSubmission(readInput())).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(store.state).toMatchObject({
      status: "error",
      error: expect.stringContaining("This API key isn't allowed to use Claude Managed Agents."),
      environment: { id: "env_1" },
      agents: { grade: { id: "agent_2" } },
    });
    expect(store.saves.at(-1)).toEqual({ kind: "error", message: store.state.error, progress: undefined });
  });

  it("doesn't record other session errors", async () => {
    const { fake, store, grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    fake.fail("createSession", apiError(429));
    await expect(grader.readSubmission(readInput())).rejects.toMatchObject({ code: "rate_limited" });
    expect(store.state.status).toBe("ready");
  });

  it("rejects with the setup's error when the hosted agent can't be set up", async () => {
    const { fake, grader } = setup();
    fake.fail("createEnvironment", apiError(401));
    await expect(grader.readSubmission(readInput())).rejects.toMatchObject({ code: "auth" });
    expect(fake.methods()).toEqual(["createEnvironment"]);
  });

  it("sweeps stale sessions at most once an hour, never when sessions are kept", async () => {
    const { fake, clock, grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    const sweeps = () => fake.calls.filter((c) => c.method === "listSessions");
    await grader.readSubmission(readInput());
    await vi.waitFor(() => expect(sweeps()).toHaveLength(3));
    expect(sweeps().map((c) => c.args[0])).toEqual(["agent_1", "agent_2", "agent_3"].map((agentId) => ({
      agentId, createdBefore: new Date(START - 1_200_000 - 600_000).toISOString(),
    })));
    expect(agentProcessSlot().lastSweepAt).toBe(START);

    clock.now += SWEEP_INTERVAL_MS - 1;
    await grader.readSubmission(readInput());
    expect(sweeps()).toHaveLength(3);
    clock.now += 1;
    await grader.readSubmission(readInput());
    await vi.waitFor(() => expect(sweeps()).toHaveLength(6));

    const kept = setup({ grade: [readingOutput(["Q1", "Q2"])] }, { keepSessions: true });
    agentProcessSlot().lastSweepAt = Number.NEGATIVE_INFINITY;
    await kept.grader.readSubmission(readInput());
    expect(kept.fake.methods()).not.toContain("listSessions");
  });

  it("accepts the submission through the agent's submit tool", async () => {
    const { fake, grader } = setup({ grade: [readingOutput(["Q1", "Q2"])] });
    await grader.readSubmission(readInput());
    expect(fake.sent().find((e) => e.type === "user.custom_tool_result")).toMatchObject({
      is_error: false, content: [{ type: "text", text: SUBMIT_ACCEPTED }],
    });
  });
});
