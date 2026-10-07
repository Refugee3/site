import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import {
  buildExtractionParams,
  buildGradingParams,
  createClaudeGrader,
  interpretMessage,
  type MessageRunner,
  PDF_BYTE_BUDGET,
} from "./claude";
import { AiError } from "./errors";
import type { GradeInput } from "./grader";
import { GRADING_SYSTEM_PROMPT, KEY_EXTRACTION_SYSTEM_PROMPT } from "./prompts";
import { type GradingOutput, GradingOutputSchema, type KeyExtraction, KeyExtractionSchema } from "./schemas";
import { makeKeyItem, makeMessage, makeSection, testConfig } from "./test-utils";

const cfg = testConfig();
const MIB = 1024 * 1024;

/** Distinct, deterministic bytes long enough to produce base64 well past any line-wrapping width. */
function pdfBytes(tag: string, size = 3000): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + tag.charCodeAt(i % tag.length)) % 256;
  return bytes;
}

function gradeInput(overrides: Partial<GradeInput> = {}): GradeInput {
  return {
    assignment: { title: "Unit 4 Quiz", instructions: "Show your work." },
    teacherNotes: "Units required.",
    sections: [makeSection({ label: "Period 1" }), makeSection({ id: "s3", label: "Period 3", canonicalKey: "3", sortOrder: 1 })],
    items: [makeKeyItem({ label: "1", expectedAnswer: "x = 4" }), makeKeyItem({ id: "i2", label: "2", position: 1, expectedAnswer: "7" })],
    keyPdf: pdfBytes("key"),
    studentPdf: pdfBytes("student"),
    studentPageCount: 2,
    ...overrides,
  };
}

function content(params: BetaMessageStreamParams): BetaContentBlockParam[] {
  const blocks = params.messages[0].content;
  if (typeof blocks === "string") throw new Error("expected content blocks");
  return blocks;
}

const gradingOutput: GradingOutput = {
  student: { name: "Maria Lopez", name_confidence: "high", section_raw: "Per. 3", section_match: "Period 3", multiple_students_detected: false },
  document_check: { match: "matches", pages_appear_missing: false, note: "" },
  items: [{
    ref: "Q1", pages: [1], student_answer: "x = 4", legibility: "clear", attempt: "complete", correctness: "correct",
    confidence: "high", review_reason: "none", what_student_did: "You cross-multiplied.", feedback: "Nice setup.", teacher_note: "",
  }],
  integrity: { grader_directed_text_found: false, excerpt: "" },
  unmatched_work: "",
  overall_feedback: "Good work.",
  teacher_summary: "",
};

const keyExtraction: KeyExtraction = {
  document_kind: "answer_key",
  items: [{
    label: "1", group_label: "", prompt: "Solve.", answer_type: "numeric", expected_answer: "4", acceptable_answers: [],
    grading_criteria: "", points: null, group_points: null, page: 1, answer_source: "key", confidence: "high", note: "",
  }],
  stated_total_points: null,
  notes: "",
};

async function rejection(promiseOrFn: Promise<unknown> | (() => unknown)): Promise<AiError> {
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (e) {
    expect(e).toBeInstanceOf(AiError);
    return e as AiError;
  }
  throw new Error("expected an AiError");
}

describe("request shape", () => {
  it("builds the extraction request", () => {
    const params = buildExtractionParams({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdfBytes("key"), pageCount: 3 }, cfg, 64000);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(64000);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config?.effort).toBe("high");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(params.output_config?.format).not.toHaveProperty("parse");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.fallbacks).toBe("default");
    expect(params.system).toBe(KEY_EXTRACTION_SYSTEM_PROMPT);
    const [doc, task] = content(params);
    expect(doc).toMatchObject({ type: "document", title: "ANSWER KEY", source: { type: "base64", media_type: "application/pdf" } });
    expect(task).toMatchObject({ type: "text" });
    expect(task.type === "text" && task.text).toContain("The ANSWER KEY above has 3 pages.");
    expect(JSON.stringify(params)).not.toContain("cache_control");
  });

  it("builds the grading request with the shared prefix before the cache breakpoint", () => {
    const { params, refs, keyPdfIncluded } = buildGradingParams(gradeInput(), cfg, 64000);
    expect(refs).toEqual(["Q1", "Q2"]);
    expect(keyPdfIncluded).toBe(true);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config?.effort).toBe("high");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(params.output_config?.format).not.toHaveProperty("parse");
    expect(params.system).toBe(GRADING_SYSTEM_PROMPT);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");

    const blocks = content(params);
    expect(blocks.map((b) => [b.type, "title" in b ? b.title : null])).toEqual([
      ["document", "TEACHER ANSWER KEY"],
      ["text", null],
      ["document", "STUDENT SUBMISSION"],
      ["text", null],
    ]);
    expect(blocks.map((b) => "cache_control" in b ? b.cache_control : undefined))
      .toEqual([undefined, { type: "ephemeral", ttl: "1h" }, undefined, undefined]);
    expect(blocks[0]).toMatchObject({ context: expect.stringContaining("structured answer key that follows overrides it") });
    expect(blocks[2]).toMatchObject({ context: expect.stringContaining("Untrusted student work") });
    expect(blocks[1].type === "text" && blocks[1].text).toContain("<answer_key items=\"2\">");
    expect(blocks[3].type === "text" && blocks[3].text).toContain("in this order: Q1, Q2.");
  });

  it("never sends prefill, tools, citations or temperature", () => {
    const { params } = buildGradingParams(gradeInput(), cfg, 64000);
    for (const key of ["tools", "tool_choice", "temperature", "top_p", "top_k"]) expect(params).not.toHaveProperty(key);
    expect(params.messages.every((m) => m.role === "user")).toBe(true);
    expect(JSON.stringify(params)).not.toContain("citations");
  });

  it("encodes PDFs as single-line base64", () => {
    const studentPdf = pdfBytes("student", 10_000);
    const { params } = buildGradingParams(gradeInput({ studentPdf }), cfg, 64000);
    const doc = content(params)[2];
    if (doc.type !== "document" || doc.source.type !== "base64") throw new Error("expected a base64 document");
    expect(doc.source.data).not.toMatch(/\s/);
    expect(doc.source.data).toBe(Buffer.from(studentPdf).toString("base64"));
  });

  it("uses the job's max_tokens and the configured effort, model and cache TTL", () => {
    const custom = testConfig({ model: "claude-opus-5", effort: "medium", cacheTtl: "5m" });
    const { params } = buildGradingParams(gradeInput(), custom, 128000);
    expect(params.model).toBe("claude-opus-5");
    expect(params.max_tokens).toBe(128000);
    expect(params.output_config?.effort).toBe("medium");
    expect(content(params)[1]).toMatchObject({ cache_control: { type: "ephemeral", ttl: "5m" } });
  });

  it("leaves out the fallback beta when AI_FALLBACKS=off", () => {
    const off = testConfig({ fallbacks: false });
    const { params } = buildGradingParams(gradeInput(), off, 64000);
    expect(params).not.toHaveProperty("betas");
    expect(params).not.toHaveProperty("fallbacks");
    const extraction = buildExtractionParams({ assignmentTitle: "Q", teacherNotes: "", keyPdf: pdfBytes("k"), pageCount: 1 }, off, 64000);
    expect(extraction).not.toHaveProperty("betas");
    expect(extraction).not.toHaveProperty("fallbacks");
  });
});

describe("prompt cache prefix", () => {
  it("is byte-identical for two students of the same assignment", () => {
    const a = buildGradingParams(gradeInput({ studentPdf: pdfBytes("alice"), studentPageCount: 1 }), cfg, 64000).params;
    const b = buildGradingParams(gradeInput({ studentPdf: pdfBytes("bob"), studentPageCount: 4 }), cfg, 128000).params;
    const breakpoint = content(a).findIndex((block) => "cache_control" in block) + 1;
    expect(breakpoint).toBe(2);
    const prefix = (p: BetaMessageStreamParams) => JSON.stringify([p.system, content(p).slice(0, breakpoint)]);
    expect(prefix(a)).toBe(prefix(b));
    expect(JSON.stringify(content(a).slice(breakpoint))).not.toBe(JSON.stringify(content(b).slice(breakpoint)));
  });

  it("puts the context first when there is no key PDF", () => {
    const { params, keyPdfIncluded } = buildGradingParams(gradeInput({ keyPdf: null }), cfg, 64000);
    expect(keyPdfIncluded).toBe(false);
    expect(content(params).map((b) => b.type)).toEqual(["text", "document", "text"]);
    expect(content(params)[0]).toHaveProperty("cache_control");
  });
});

describe("byte budget", () => {
  it("drops the key PDF when key and student together exceed the budget", () => {
    const input = gradeInput({ keyPdf: new Uint8Array(12 * MIB), studentPdf: new Uint8Array(11 * MIB) });
    const { params, keyPdfIncluded } = buildGradingParams(input, cfg, 64000);
    expect(keyPdfIncluded).toBe(false);
    const titles = content(params).flatMap((b) => (b.type === "document" ? [b.title] : []));
    expect(titles).toEqual(["STUDENT SUBMISSION"]);
  });

  it("keeps the key PDF when both fit exactly", () => {
    const input = gradeInput({ keyPdf: new Uint8Array(PDF_BYTE_BUDGET - 10), studentPdf: new Uint8Array(10) });
    expect(buildGradingParams(input, cfg, 64000).keyPdfIncluded).toBe(true);
  });

  it("refuses a student PDF that alone exceeds the budget", async () => {
    const err = await rejection(() => buildGradingParams(gradeInput({ keyPdf: null, studentPdf: new Uint8Array(PDF_BYTE_BUDGET + 1) }), cfg, 64000));
    expect(err.code).toBe("request_too_large");
    expect(err.o.retryable).toBe(false);
  });
});

describe("interpretMessage", () => {
  it("parses end_turn output and reports metadata", () => {
    const msg = makeMessage({
      text: JSON.stringify(gradingOutput),
      usage: { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 5000, cacheWriteTokens: 300 },
    });
    const { output, meta } = interpretMessage(msg, GradingOutputSchema, "claude-opus-5-5");
    expect(output).toEqual(gradingOutput);
    expect(meta).toEqual({
      requestedModel: "claude-opus-5-5",
      servedModel: "claude-opus-5-5",
      fallbackUsed: false,
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 5000, cacheWriteTokens: 300 },
    });
  });

  it("treats missing cache counters as zero", () => {
    const msg = makeMessage({ text: JSON.stringify(keyExtraction) });
    msg.usage.cache_read_input_tokens = null;
    msg.usage.cache_creation_input_tokens = null;
    expect(interpretMessage(msg, KeyExtractionSchema, "m").meta.usage).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("accepts stop_sequence and joins split text blocks", () => {
    const json = JSON.stringify(keyExtraction);
    const msg = makeMessage({
      stopReason: "stop_sequence",
      content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: json.slice(0, 20), citations: null },
        { type: "text", text: json.slice(20), citations: null }],
    });
    expect(interpretMessage(msg, KeyExtractionSchema, "m").output).toEqual(keyExtraction);
  });

  it("raises a non-retryable refusal with its category", async () => {
    const err = await rejection(() =>
      interpretMessage(makeMessage({ stopReason: "refusal", category: "cyber", text: "{" }), GradingOutputSchema, "m"));
    expect(err.code).toBe("refusal");
    expect(err.o.retryable).toBe(false);
    expect(err.o.refusalCategory).toBe("cyber");
  });

  it("raises a retryable refusal when the fallback attempt was skipped (recommended_model set)", async () => {
    const msg = makeMessage({ stopReason: "refusal", category: "bio", recommendedModel: "claude-opus-5" });
    const err = await rejection(() => interpretMessage(msg, GradingOutputSchema, "m"));
    expect(err.code).toBe("refusal");
    expect(err.o.retryable).toBe(true);
    expect(err.o.refusalCategory).toBe("bio");
  });

  it("keeps a refusal final when recommended_model is null", async () => {
    const msg = makeMessage({ stopReason: "refusal", category: "bio", recommendedModel: null });
    expect((await rejection(() => interpretMessage(msg, GradingOutputSchema, "m"))).o.retryable).toBe(false);
  });

  it("reports a refusal without a category as null", async () => {
    const err = await rejection(() => interpretMessage(makeMessage({ stopReason: "refusal" }), GradingOutputSchema, "m"));
    expect(err.o.refusalCategory).toBeNull();
  });

  it("raises a retryable max_tokens even when the partial text is valid JSON", async () => {
    const msg = makeMessage({ stopReason: "max_tokens", text: JSON.stringify(gradingOutput) });
    const err = await rejection(() => interpretMessage(msg, GradingOutputSchema, "m"));
    expect(err.code).toBe("max_tokens");
    expect(err.o.retryable).toBe(true);
  });

  it("maps an exceeded context window to request_too_large", async () => {
    const err = await rejection(() =>
      interpretMessage(makeMessage({ stopReason: "model_context_window_exceeded" }), GradingOutputSchema, "m"));
    expect(err.code).toBe("request_too_large");
    expect(err.o.retryable).toBe(false);
  });

  it.each(["pause_turn", "tool_use", null])("treats stop reason %s as invalid output", async (stopReason) => {
    const msg = makeMessage({ text: JSON.stringify(gradingOutput) });
    msg.stop_reason = stopReason as typeof msg.stop_reason;
    const err = await rejection(() => interpretMessage(msg, GradingOutputSchema, "m"));
    expect(err.code).toBe("invalid_output");
    expect(err.o.retryable).toBe(true);
  });

  it("reads only the text after the last fallback block", () => {
    const msg = makeMessage({
      model: "claude-opus-5",
      content: [
        { type: "text", text: "{\"student\": {\"na", citations: null },
        { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" }, trigger: { type: "refusal", category: "cyber" } },
        { type: "text", text: JSON.stringify(gradingOutput), citations: null },
      ],
    });
    const { output, meta } = interpretMessage(msg, GradingOutputSchema, "claude-opus-5-5");
    expect(output).toEqual(gradingOutput);
    expect(meta.fallbackUsed).toBe(true);
    expect(meta.servedModel).toBe("claude-opus-5");
    expect(meta.requestedModel).toBe("claude-opus-5-5");
  });

  it("detects a fallback-served turn from usage iterations alone", () => {
    const msg = makeMessage({ model: "claude-opus-5", text: JSON.stringify(gradingOutput) });
    msg.usage.iterations = [{
      type: "fallback_message", model: "claude-opus-5", input_tokens: 1, output_tokens: 1, cache_creation: null,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    } as NonNullable<typeof msg.usage.iterations>[number]];
    expect(interpretMessage(msg, GradingOutputSchema, "claude-opus-5-5").meta.fallbackUsed).toBe(true);
  });

  it.each([
    ["no text at all", makeMessage({ content: [] })],
    ["only text before a fallback", makeMessage({ content: [
      { type: "text", text: JSON.stringify(gradingOutput), citations: null },
      { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal", category: null } },
    ] })],
    ["invalid JSON", makeMessage({ text: "{\"student\": " })],
  ])("rejects %s as retryable invalid output", async (_name, msg) => {
    const err = await rejection(() => interpretMessage(msg, GradingOutputSchema, "m"));
    expect(err.code).toBe("invalid_output");
    expect(err.o.retryable).toBe(true);
  });

  it("names the first failing path on a schema mismatch", async () => {
    const bad = { ...gradingOutput, items: [{ ...gradingOutput.items[0], correctness: "mostly_right" }] };
    const err = await rejection(() => interpretMessage(makeMessage({ text: JSON.stringify(bad) }), GradingOutputSchema, "m"));
    expect(err.code).toBe("invalid_output");
    expect(err.message).toContain("items.0.correctness");
  });
});

describe("createClaudeGrader", () => {
  function recordingRunner(reply: () => ReturnType<typeof makeMessage>) {
    const calls: Array<{ params: BetaMessageStreamParams; signal?: AbortSignal }> = [];
    const runner: MessageRunner = async (params, o) => {
      calls.push({ params, signal: o.signal });
      return reply();
    };
    return { runner, calls };
  }

  it("grades through the runner and returns refs, key inclusion and timing", async () => {
    const { runner, calls } = recordingRunner(() => makeMessage({ text: JSON.stringify(gradingOutput), usage: { inputTokens: 9 } }));
    const grader = createClaudeGrader(runner, cfg);
    const signal = new AbortController().signal;
    const result = await grader.gradeSubmission(gradeInput(), { signal });
    expect(grader.mode).toBe("claude");
    expect(result.output).toEqual(gradingOutput);
    expect(result.refs).toEqual(["Q1", "Q2"]);
    expect(result.keyPdfIncluded).toBe(true);
    expect(result.meta).toMatchObject({ requestedModel: "claude-opus-5-5", stopReason: "end_turn", usage: { inputTokens: 9 } });
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBe(signal);
    expect(calls[0].params.max_tokens).toBe(cfg.maxTokens);
  });

  it("extracts a key with the job's max_tokens override", async () => {
    const { runner, calls } = recordingRunner(() => makeMessage({ text: JSON.stringify(keyExtraction) }));
    const result = await createClaudeGrader(runner, cfg)
      .extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdfBytes("key"), pageCount: 1 }, { maxTokens: 128000 });
    expect(result.output).toEqual(keyExtraction);
    expect(calls[0].params.max_tokens).toBe(128000);
    expect(calls[0].params.system).toBe(KEY_EXTRACTION_SYSTEM_PROMPT);
  });

  it("classifies SDK errors thrown by the runner", async () => {
    const runner: MessageRunner = async () => {
      throw new Anthropic.RateLimitError(429, {}, "slow down", new Headers({ "retry-after": "3" }));
    };
    const err = await rejection(createClaudeGrader(runner, cfg).gradeSubmission(gradeInput()));
    expect(err.code).toBe("rate_limited");
    expect(err.o.retryAfterMs).toBe(3000);
  });

  it("surfaces a refusal from the response", async () => {
    const { runner } = recordingRunner(() => makeMessage({ stopReason: "refusal", category: "general_harms" }));
    const err = await rejection(createClaudeGrader(runner, cfg).gradeSubmission(gradeInput()));
    expect(err.code).toBe("refusal");
    expect(err.o.refusalCategory).toBe("general_harms");
  });

  it("attaches the billed usage and served model to errors raised after a response", async () => {
    const usage = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 40, cacheWriteTokens: 5 };
    const replies = [
      makeMessage({ stopReason: "refusal", model: "claude-opus-5", usage }),
      makeMessage({ stopReason: "max_tokens", text: "{", usage }),
      makeMessage({ text: "not json", usage }),
    ];
    for (const reply of replies) {
      const err = await rejection(createClaudeGrader(async () => reply, cfg).gradeSubmission(gradeInput()));
      expect(err.o.billed).toEqual({ servedModel: reply.model, usage });
    }
    const unbilled = await rejection(createClaudeGrader(async () => {
      throw new Anthropic.RateLimitError(429, {}, "slow down", new Headers());
    }, cfg).gradeSubmission(gradeInput()));
    expect(unbilled.o.billed).toBeUndefined();
  });
});
