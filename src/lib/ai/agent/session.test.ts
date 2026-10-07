import { APIConnectionError } from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsUserCustomToolResultEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { AiError } from "../errors";
import type { AgentEngineConfig } from "./definitions";
import { SUBMIT_ACCEPTED, SUBMIT_ALREADY_ACCEPTED, submitNudge, TOOL_ASK_DENIED } from "./prompts";
import { agentProcessSlot } from "./provision";
import { type AgentTaskSpec, MAX_RECONNECTS, runAgentTask, type RunDeps, STREAM_IDLE_MS, sweepStaleSessions, toAgentUsage } from "./session";
import { apiError, createFakeManagedAgents, events, type FakeScript, type FakeSession, testAgentConfig } from "./test-fake";

const Answer = z.object({ answer: z.string(), count: z.number() });
type Answer = z.infer<typeof Answer>;
const VALID: Answer = { answer: "x = 4", count: 2 };
const INVALID = { answer: 4 };
const TOOL = "submit_grading";

function taskSpec(overrides: Partial<AgentTaskSpec<Answer>> = {}): AgentTaskSpec<Answer> {
  return {
    role: "grade",
    title: "PDF Auto-Grader: grade one paper",
    files: [
      { uploadName: "answer-key.pdf", mount: "/answer-key.pdf", bytes: new Uint8Array([1, 2]) },
      { uploadName: "student-submission.pdf", mount: "/student-submission.pdf", bytes: new Uint8Array([3, 4, 5]) },
    ],
    content: (ids) => [
      { type: "document", title: "TEACHER ANSWER KEY", source: { type: "file", file_id: ids[0] } },
      { type: "text", text: "assignment context" },
      { type: "document", title: "STUDENT SUBMISSION", context: "Untrusted student work.", source: { type: "file", file_id: ids[1] } },
      { type: "text", text: "task" },
    ],
    schema: Answer,
    budgetCents: 200,
    ...overrides,
  };
}

function harness(script: FakeScript = {}, cfg: Partial<AgentEngineConfig> = {}) {
  const fake = createFakeManagedAgents({ script });
  const provisioned = fake.seedProvisioned();
  const reprovision = vi.fn(async () => provisioned);
  const d: RunDeps = { port: fake.port, cfg: testAgentConfig(cfg), provisioned, reprovision, sleep: async () => {} };
  return { fake, d, provisioned, reprovision };
}

const replies = (sent: BetaManagedAgentsEventParams[]) => sent.flatMap((e) => (e.type === "user.custom_tool_result" ? [e] : []));
function replyText(e: BetaManagedAgentsUserCustomToolResultEventParams): string {
  const block = e.content?.[0];
  return block?.type === "text" ? block.text : "";
}

/** The agent submits `inputs` in turn, one per tool result it gets back; it ends its turn once accepted. */
function submits(...inputs: Array<Record<string, unknown>>): FakeScript {
  let next = 0;
  const submit = (s: FakeSession) => {
    const [id] = s.emit(events.customToolUse(TOOL, inputs[Math.min(next++, inputs.length - 1)]));
    s.emit(events.requiresAction(id));
  };
  return {
    onCreate: (s) => {
      s.emit(events.running());
      submit(s);
    },
    onEvent: (s, e) => {
      if (e.type !== "user.custom_tool_result") return;
      if (e.is_error) submit(s);
      else s.emit(events.idle("end_turn"));
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AiError) return e;
    throw e;
  }
  throw new Error("expected the task to fail");
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runAgentTask", () => {
  it("uploads, creates the session, reads the accepted submission, and cleans up", async () => {
    const script = submits(VALID);
    const onCreate = script.onCreate!;
    script.onCreate = (s) => {
      s.usage = {
        input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 }, list_cost: { amount: "42", currency: "USD" },
        active_seconds: 95.6,
      };
      onCreate(s);
    };
    const { fake, d, provisioned } = harness(script);
    const spec = taskSpec();
    const result = await runAgentTask(d, spec);

    expect(fake.uploads).toEqual([
      { id: "file_1", name: "answer-key.pdf", expiresInSeconds: 3600 },
      { id: "file_2", name: "student-submission.pdf", expiresInSeconds: 3600 },
    ]);
    const create = fake.calls.find((c) => c.method === "createSession")!;
    expect(create.args).toEqual([{
      agent: { type: "agent", id: provisioned.agents.grade.id, version: 1 },
      environment_id: provisioned.environmentId,
      title: "PDF Auto-Grader: grade one paper",
      metadata: { app: "pdf-autograder", install: provisioned.installId, role: "grade" },
      resources: [
        { type: "file", file_id: "file_1", mount_path: "/answer-key.pdf" },
        { type: "file", file_id: "file_2", mount_path: "/student-submission.pdf" },
      ],
      budget: { type: "limit", max_list_cost: { amount: "200", currency: "USD" } },
      initial_events: [{ type: "user.message", content: spec.content(["file_1", "file_2"]) }],
    }, { timeoutMs: 60_000 }]);
    // Uploads and the create are never aborted mid-request: they get a timeout only.
    for (const c of fake.calls.filter((x) => x.method === "uploadPdf")) expect(c.args[3]).toEqual({ timeoutMs: 120_000 });

    const methods = fake.methods();
    expect(methods.indexOf("streamEvents")).toBeGreaterThan(methods.indexOf("createSession"));
    expect(methods.indexOf("streamEvents")).toBeLessThan(methods.indexOf("listEvents"));
    expect(replies(fake.sent())).toEqual([{
      type: "user.custom_tool_result", custom_tool_use_id: expect.any(String), content: [{ type: "text", text: SUBMIT_ACCEPTED }], is_error: false,
    }]);

    expect(result).toEqual({
      output: VALID,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 10 },
      cost: { listCostCents: 42, activeSeconds: 96 },
      sessionId: "sesn_1",
      durationMs: expect.any(Number),
    });
    // The session went idle on its own: no interrupt, then delete session and uploads.
    expect(fake.sent().some((e) => e.type === "user.interrupt")).toBe(false);
    expect(methods.slice(-4)).toEqual(["retrieveSession", "deleteSession", "deleteFile", "deleteFile"]);
    expect(fake.deletedSessions.has("sesn_1")).toBe(true);
    expect(fake.files.size).toBe(0);
    expect(agentProcessSlot().active.size).toBe(0);
    // Logs carry ids and costs, never the student's work.
    const logged = JSON.stringify([vi.mocked(console.info).mock.calls, vi.mocked(console.warn).mock.calls]);
    expect(logged).toContain("[agent] grade: session sesn_1 succeeded in");
    expect(logged).toContain("$0.42");
    expect(logged).not.toContain("x = 4");
  });

  it("keeps the session id in the process's active set while it runs", async () => {
    let active: string[] = [];
    const script = submits(VALID);
    const onEvent = script.onEvent!;
    script.onEvent = (s, e) => {
      active = [...agentProcessSlot().active];
      onEvent(s, e);
    };
    await runAgentTask(harness(script).d, taskSpec());
    expect(active).toEqual(["sesn_1"]);
  });

  it("rejects an invalid submission with the problems by path and accepts the corrected one", async () => {
    const { fake, d } = harness(submits(INVALID, VALID));
    const result = await runAgentTask(d, taskSpec());
    const sent = replies(fake.sent());
    expect(sent).toHaveLength(2);
    expect(sent[0].is_error).toBe(true);
    expect(replyText(sent[0])).toMatch(/^Not accepted \(attempt 1 of 3\)\. Fix every problem below, then call submit_grading again/);
    expect(replyText(sent[0])).toContain("\n- answer: ");
    expect(replyText(sent[0])).toContain("\n- count: ");
    expect(sent[1]).toMatchObject({ is_error: false, content: [{ type: "text", text: SUBMIT_ACCEPTED }] });
    expect(result.output).toEqual(VALID);
  });

  it("rejects schema-valid submissions with semantic problems, then accepts the last allowed one as it is", async () => {
    const check = vi.fn(() => ["items must have exactly 2 entries"]);
    const { fake, d } = harness(submits({ answer: "a", count: 1 }, { answer: "b", count: 1 }, { answer: "c", count: 1 }));
    const result = await runAgentTask(d, taskSpec({ check }));
    const texts = replies(fake.sent()).map(replyText);
    expect(texts[0]).toContain("attempt 1 of 3");
    expect(texts[0]).toContain("- items must have exactly 2 entries");
    expect(texts[1]).toContain("attempt 2 of 3");
    expect(texts[2]).toBe(SUBMIT_ACCEPTED);
    expect(result.output).toEqual({ answer: "c", count: 1 });
  });

  it("fails with invalid_output after three invalid submissions, and cleans up", async () => {
    const { fake, d } = harness(submits(INVALID));
    const err = await rejection(runAgentTask(d, taskSpec()));
    expect(err.code).toBe("invalid_output");
    expect(err.o.retryable).toBe(true);
    expect(err.message).toMatch(/^The hosted agent's answer didn't match the required form after 3 attempts: answer: /);
    expect(replies(fake.sent())).toHaveLength(2);
    expect(fake.deletedSessions.has("sesn_1")).toBe(true);
    expect(fake.files.size).toBe(0);
  });

  it("lists at most 20 problems per rejection", async () => {
    const Many = z.object(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, z.string()])));
    const { fake, d } = harness(submits({}, Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, "ok"]))));
    await runAgentTask(d, taskSpec({ schema: Many as unknown as z.ZodType<Answer> }));
    const lines = replyText(replies(fake.sent())[0]).split("\n");
    expect(lines.filter((l) => l.startsWith("- f"))).toHaveLength(20);
    expect(lines.at(-1)).toBe("- …and 5 more problems.");
  });

  it("nudges once when the agent ends its turn without submitting", async () => {
    const { fake, d } = harness({
      onCreate: (s) => s.emit(events.running(), events.message("Here is my reading."), events.idle("end_turn")),
      onEvent: (s, e) => {
        if (e.type === "user.message") s.emit(events.customToolUse(TOOL, VALID));
        if (e.type === "user.custom_tool_result") s.emit(events.idle("end_turn"));
      },
    });
    const result = await runAgentTask(d, taskSpec());
    expect(fake.sent().filter((e) => e.type === "user.message")).toEqual([
      { type: "user.message", content: [{ type: "text", text: submitNudge(TOOL) }] },
    ]);
    expect(result.output).toEqual(VALID);
  });

  it("fails with invalid_output when the agent ends its turn again after the nudge", async () => {
    const { fake, d } = harness({
      onCreate: (s) => s.emit(events.running(), events.idle("end_turn")),
      onEvent: (s, e) => {
        if (e.type === "user.message") s.emit(events.running(), events.idle("end_turn"));
      },
    });
    const err = await rejection(runAgentTask(d, taskSpec()));
    expect(err).toMatchObject({ code: "invalid_output", message: "The hosted agent finished without submitting an answer." });
    expect(fake.sent().filter((e) => e.type === "user.message")).toHaveLength(1);
  });

  it("answers an unknown tool without counting it, and a second submission after acceptance", async () => {
    const { fake, d } = harness({
      onCreate: (s) => s.emit(events.running(), events.customToolUse("submit_answer_key", VALID)),
      onEvent: (s, e) => {
        if (e.type !== "user.custom_tool_result") return;
        if (e.is_error) s.emit(events.customToolUse(TOOL, VALID));
        else if (replyText(e) === SUBMIT_ACCEPTED) s.emit(events.customToolUse(TOOL, { answer: "again", count: 9 }));
        else s.emit(events.idle("end_turn"));
      },
    });
    const result = await runAgentTask(d, taskSpec());
    expect(replies(fake.sent()).map((e) => [replyText(e), e.is_error])).toEqual([
      ["Unknown tool. Use submit_grading.", true],
      [SUBMIT_ACCEPTED, false],
      [SUBMIT_ALREADY_ACCEPTED, false],
    ]);
    expect(result.output).toEqual(VALID);
  });

  it("denies a tool use the auto policy left to the client, once", async () => {
    let askId = "";
    const { fake, d } = harness({
      onCreate: (s) => {
        s.emit(events.running(), events.toolUse("bash", "allow"));
        [askId] = s.emit(events.toolUse("bash", "ask"));
        s.emit(events.requiresAction(askId));
      },
      onEvent: (s, e) => {
        if (e.type === "user.tool_confirmation") s.emit(events.requiresAction(askId), events.customToolUse(TOOL, VALID));
        if (e.type === "user.custom_tool_result") s.emit(events.idle("end_turn"));
      },
    });
    await runAgentTask(d, taskSpec());
    expect(fake.sent().filter((e) => e.type === "user.tool_confirmation")).toEqual([
      { type: "user.tool_confirmation", tool_use_id: askId, result: "deny", deny_message: TOOL_ASK_DENIED },
    ]);
  });

  describe("reconnects", () => {
    it("dedupes the history after a dropped stream and handles what was emitted during the gap", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running()),
        onList: (s, n) => {
          if (n !== 1) return;
          s.emit(events.customToolUse(TOOL, INVALID, "sevt_tu1"));
          s.dropStream();
        },
        onEvent: (s, e) => {
          // The stream is gone when the agent submits again: only the next history has it.
          if (e.type === "user.custom_tool_result" && e.is_error) s.emit(events.customToolUse(TOOL, VALID, "sevt_tu2"));
          if (e.type === "user.custom_tool_result" && !e.is_error) s.emit(events.idle("end_turn"));
        },
      });
      const result = await runAgentTask(d, taskSpec());
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(2);
      expect(replies(fake.sent()).map((e) => [e.custom_tool_use_id, e.is_error])).toEqual([["sevt_tu1", true], ["sevt_tu2", false]]);
      expect(result.output).toEqual(VALID);
    });

    it("never handles a replayed event twice: no second nudge for an end of turn the history repeats", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running(), events.idle("end_turn")),
        onEvent: (s, e) => {
          if (e.type === "user.message") s.dropStream();
          if (e.type === "user.custom_tool_result") s.emit(events.idle("end_turn"));
        },
        onStream: (s, n) => {
          if (n === 2) s.emit(events.customToolUse(TOOL, VALID));
        },
      });
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(2);
      expect(fake.sent().filter((e) => e.type === "user.message")).toHaveLength(1);
    });

    it("ends on a terminal event that only the history has, without waiting on the live stream", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running()),
        onList: (s, n) => {
          if (n !== 1) return;
          s.dropStream();
          s.emit(events.idle("budget_reached"));
        },
      });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err.code).toBe("budget_reached");
      expect(fake.methods().filter((m) => m === "listEvents")).toHaveLength(2);
    });

    it("reconnects after the watchdog sees no event for STREAM_IDLE_MS", async () => {
      vi.useFakeTimers();
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running()),
        onStream: (s, n) => {
          if (n === 2) s.emit(events.customToolUse(TOOL, VALID));
        },
        onEvent: (s, e) => {
          if (e.type === "user.custom_tool_result") s.emit(events.idle("end_turn"));
        },
      });
      const task = runAgentTask(d, taskSpec());
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS - 1);
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(task).resolves.toMatchObject({ output: VALID });
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(2);
    });

    it("resyncs when requires_action names an event the stream never delivered", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running()),
        onList: (s, n) => {
          if (n !== 1) return;
          const [missed] = s.miss(events.customToolUse(TOOL, VALID));
          s.emit(events.requiresAction(missed));
        },
        onEvent: (s, e) => {
          if (e.type === "user.custom_tool_result") s.emit(events.idle("end_turn"));
        },
      });
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(2);
      expect(replies(fake.sent())).toHaveLength(1);
    });

    it("resets the reconnect budget whenever a connection brings something new", async () => {
      vi.useFakeTimers();
      const stalls = MAX_RECONNECTS + 1;
      const { fake, d } = harness({
        onStream: (s, n) => {
          s.emit(n <= stalls ? events.message(`progress ${n}`) : events.customToolUse(TOOL, VALID));
        },
        onEvent: (s, e) => {
          if (e.type === "user.custom_tool_result") s.emit(events.idle("end_turn"));
        },
      }, { sessionTimeoutMs: 10 * stalls * STREAM_IDLE_MS });
      const task = runAgentTask(d, taskSpec());
      for (let i = 0; i < stalls; i++) await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS);
      await expect(task).resolves.toMatchObject({ output: VALID });
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(stalls + 1);
    });

    it("gives up after MAX_RECONNECTS consecutive reconnects without progress", async () => {
      const { fake, d } = harness({ onList: (s) => s.dropStream() });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err).toMatchObject({ code: "connection", message: "Lost the connection to the hosted agent too many times." });
      expect(err.o.retryable).toBe(true);
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(MAX_RECONNECTS + 1);
    });

    it("backs off 500 ms, doubling up to 10 s", async () => {
      const { d } = harness({ onList: (s) => s.dropStream() });
      const sleep = vi.fn(async () => {});
      await rejection(runAgentTask({ ...d, sleep }, taskSpec()));
      expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    });

    it("reconnects when the history fetch fails with a connection error", async () => {
      const { fake, d } = harness(submits(VALID));
      fake.fail("listEvents", new APIConnectionError({ message: "reset" }));
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(fake.methods().filter((m) => m === "listEvents")).toHaveLength(2);
    });

    it("fails on a stream error that isn't a dropped connection", async () => {
      const { fake, d } = harness(submits(VALID));
      fake.fail("streamEvents", apiError(404));
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err).toMatchObject({ code: "server_error", message: "The hosted agent's session disappeared." });
    });
  });

  describe("tool replies whose send fails", () => {
    const isResult = (id: string) => ([, sent]: unknown[]) =>
      (sent as BetaManagedAgentsEventParams[]).some((e) => e.type === "user.custom_tool_result" && e.custom_tool_use_id === id);

    it("continues when the send failed after the reply landed: the history shows it answered", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running(), events.customToolUse(TOOL, INVALID, "sevt_tu1")),
        onEvent: (s, e) => {
          if (e.type === "user.custom_tool_result" && e.is_error) s.emit(events.customToolUse(TOOL, VALID, "sevt_tu2"));
          if (e.type === "user.custom_tool_result" && !e.is_error) s.emit(events.idle("end_turn"));
        },
      });
      fake.fail("sendEvents", apiError(409), { after: true, match: isResult("sevt_tu1") });
      const result = await runAgentTask(d, taskSpec());
      const sent = replies(fake.sent());
      expect(sent.map((e) => e.custom_tool_use_id)).toEqual(["sevt_tu1", "sevt_tu2"]);
      expect(replyText(sent[0])).toContain("attempt 1 of 3");
      expect(replyText(sent[1])).toBe(SUBMIT_ACCEPTED);
      expect(result.output).toEqual(VALID);
    });

    it("re-sends the same reply after reconnecting when the send failed before landing", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running(), events.customToolUse(TOOL, INVALID, "sevt_tu1")),
        onEvent: (s, e) => {
          if (e.type === "user.custom_tool_result" && e.is_error) s.emit(events.customToolUse(TOOL, VALID, "sevt_tu2"));
          if (e.type === "user.custom_tool_result" && !e.is_error) s.emit(events.idle("end_turn"));
        },
      });
      fake.fail("sendEvents", apiError(503), { match: isResult("sevt_tu1") });
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      const sent = replies(fake.sent());
      expect(sent.map((e) => e.custom_tool_use_id)).toEqual(["sevt_tu1", "sevt_tu1", "sevt_tu2"]);
      expect(sent[1]).toBe(sent[0]);
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(2);
    });

    it("fails at once when the key is rejected", async () => {
      const { fake, d } = harness(submits(INVALID, VALID));
      fake.fail("sendEvents", apiError(401), { match: ([, sent]) => (sent as BetaManagedAgentsEventParams[])[0].type === "user.custom_tool_result" });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err.code).toBe("auth");
      expect(err.o.pauseWorker).toBe(true);
    });

    it("fails when the nudge can't be sent", async () => {
      const { fake, d } = harness({ onCreate: (s) => s.emit(events.running(), events.idle("end_turn")) });
      fake.fail("sendEvents", apiError(400), { match: ([, sent]) => (sent as BetaManagedAgentsEventParams[])[0].type === "user.message" });
      expect((await rejection(runAgentTask(d, taskSpec()))).code).toBe("bad_request");
    });
  });

  describe("stop reasons and session errors", () => {
    it("reports budget_reached with the billed usage and cost from the session", async () => {
      const { d } = harness({
        onCreate: (s) => {
          s.usage = { input_tokens: 9000, output_tokens: 700, list_cost: { amount: "201", currency: "USD" }, active_seconds: 42.4 };
          s.emit(events.running(), events.idle("budget_reached"));
        },
      });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err).toMatchObject({ code: "budget_reached", message: "The hosted agent reached its spending cap for this task." });
      expect(err.o.retryable).toBe(true);
      expect(err.o.billed).toEqual({
        servedModel: "claude-opus-5-5",
        usage: { inputTokens: 9000, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0 },
        agent: { listCostCents: 201, activeSeconds: 42 },
      });
    });

    it("falls back to the model-request spans for usage when the session can't be read", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running(), events.modelRequestEnd({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }),
          events.modelRequestEnd({ input: 1, output: 1 }), events.idle("budget_reached")),
      });
      fake.fail("retrieveSession", apiError(500));
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err.o.billed).toEqual({
        servedModel: "claude-opus-5-5",
        usage: { inputTokens: 11, outputTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 2 },
        agent: { listCostCents: null, activeSeconds: 0 },
      });
    });

    it("reports a refusal as final, with its category", async () => {
      const { d } = harness({
        onCreate: (s) => s.emit(events.running(), events.idle("refusal", { type: "refusal", category: "bio", explanation: null })),
      });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err).toMatchObject({ code: "refusal", message: "The hosted agent declined to answer." });
      expect(err.o).toMatchObject({ retryable: false, refusalCategory: "bio" });
    });

    it("maps retries_exhausted to the last session error", async () => {
      const { d } = harness({
        onCreate: (s) => s.emit(events.running(), events.error("model_overloaded_error", "retrying"),
          events.error("model_overloaded_error", "exhausted"), events.idle("retries_exhausted")),
      });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err.code).toBe("overloaded");
      expect(err.o.retryable).toBe(true);
    });

    it("fails at once on a billing error, even while Anthropic retries", async () => {
      const { d } = harness({ onCreate: (s) => s.emit(events.running(), events.error("billing_error", "retrying")) });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err.code).toBe("billing");
      expect(err.o).toMatchObject({ retryable: false, pauseWorker: true });
    });

    it("maps a termination without a submission to a retryable server error", async () => {
      const { fake, d } = harness({ onCreate: (s) => s.emit(events.running(), events.terminated()) });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err).toMatchObject({ code: "server_error", message: "The hosted agent's session ended before it submitted an answer." });
      expect(err.o.retryable).toBe(true);
      // A terminated session needs no interrupt; it is still deleted.
      expect(fake.sent().some((e) => e.type === "user.interrupt")).toBe(false);
      expect(fake.deletedSessions.has("sesn_1")).toBe(true);
      expect(err.o.billed).toBeUndefined();
    });

    it("maps a deleted session to a retryable server error", async () => {
      const { d } = harness({ onCreate: (s) => s.emit(events.running(), events.deleted()) });
      expect(await rejection(runAgentTask(d, taskSpec())))
        .toMatchObject({ code: "server_error", message: "The hosted agent's session was deleted." });
    });
  });

  describe("abort and timeout", () => {
    it("stops on the job signal: interrupts, waits for the session to stop running, deletes it, and rejects aborted", async () => {
      const job = new AbortController();
      let polls = 0;
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running()),
        onList: () => job.abort(),
        onRetrieve: (s) => {
          s.status = ++polls < 3 ? "running" : "idle";
        },
      });
      const err = await rejection(runAgentTask(d, taskSpec(), { signal: job.signal }));
      expect(err).toMatchObject({ code: "aborted", message: "The grading job was stopped." });
      expect(err.o.retryable).toBe(true);
      expect(fake.sent()).toEqual([{ type: "user.interrupt" }]);
      expect(fake.methods().slice(-7)).toEqual(["sendEvents", "retrieveSession", "retrieveSession", "retrieveSession", "deleteSession",
        "deleteFile", "deleteFile"]);
      expect(fake.deletedSessions.has("sesn_1")).toBe(true);
      // Cleanup never uses the aborted signal.
      for (const c of fake.calls.filter((x) => ["sendEvents", "retrieveSession", "deleteSession", "deleteFile"].includes(x.method))) {
        expect(c.args.at(-1)).toEqual({ timeoutMs: 10_000 });
      }
    });

    it("leaves a session that never stops running to the sweep", async () => {
      const job = new AbortController();
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running()),
        onList: () => job.abort(),
        onRetrieve: (s) => {
          s.status = "running";
        },
      });
      await rejection(runAgentTask(d, taskSpec(), { signal: job.signal }));
      expect(fake.methods().filter((m) => m === "retrieveSession")).toHaveLength(20);
      expect(fake.deletedSessions.size).toBe(0);
      expect(fake.files.size).toBe(0);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain("[agent] couldn't delete session sesn_1; the hourly sweep retries");
    });

    it("rejects with timeout when the session runs past its limit", async () => {
      vi.useFakeTimers();
      const { d } = harness({ onCreate: (s) => s.emit(events.running()) }, { sessionTimeoutMs: 120_000 });
      const task = rejection(runAgentTask(d, taskSpec()));
      await vi.advanceTimersByTimeAsync(120_000);
      const err = await task;
      expect(err).toMatchObject({ code: "timeout", message: "The hosted agent took longer than 2 minutes." });
      expect(err.o.retryable).toBe(true);
    });

    it("says \"1 minute\" for the shortest session limit", async () => {
      vi.useFakeTimers();
      const { d } = harness({ onCreate: (s) => s.emit(events.running()) }, { sessionTimeoutMs: 60_000 });
      const task = rejection(runAgentTask(d, taskSpec()));
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(task).resolves.toMatchObject({ code: "timeout", message: "The hosted agent took longer than 1 minute." });
    });

    it("keeps an accepted submission when the stream drops before the turn ends", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running(), events.customToolUse(TOOL, VALID)),
        onEvent: (s) => s.dropStream(),
      });
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(fake.methods().filter((m) => m === "streamEvents")).toHaveLength(1);
      expect(fake.sent().at(-1)).toEqual({ type: "user.interrupt" });
      expect(fake.deletedSessions.has("sesn_1")).toBe(true);
    });

    it("keeps an accepted submission when the job is stopped before the turn ends", async () => {
      const job = new AbortController();
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running(), events.customToolUse(TOOL, VALID)),
        onEvent: () => job.abort(),
      });
      await expect(runAgentTask(d, taskSpec(), { signal: job.signal })).resolves.toMatchObject({ output: VALID });
      expect(fake.deletedSessions.has("sesn_1")).toBe(true);
    });

    it("keeps an accepted submission when a later reply fails, even with a rejected key", async () => {
      const { fake, d } = harness({
        onCreate: (s) => s.emit(events.running(), events.customToolUse(TOOL, VALID, "sevt_tu1")),
        onEvent: (s, e) => {
          if (e.type === "user.custom_tool_result" && e.custom_tool_use_id === "sevt_tu1") s.emit(events.customToolUse(TOOL, VALID, "sevt_tu2"));
        },
      });
      fake.fail("sendEvents", apiError(401), {
        match: ([, sent]) => (sent as BetaManagedAgentsEventParams[])
          .some((e) => e.type === "user.custom_tool_result" && e.custom_tool_use_id === "sevt_tu2"),
      });
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(replies(fake.sent()).map(replyText)).toEqual([SUBMIT_ACCEPTED, SUBMIT_ALREADY_ACCEPTED]);
    });

    it("stops waiting for the turn to end GRACE_MS after acceptance", async () => {
      vi.useFakeTimers();
      const { fake, d } = harness({ onCreate: (s) => s.emit(events.running(), events.customToolUse(TOOL, VALID)) });
      const task = runAgentTask(d, taskSpec());
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(task).resolves.toMatchObject({ output: VALID });
      expect(fake.sent().at(-1)).toEqual({ type: "user.interrupt" });
    });

    it("stops during the upload without creating a session, and deletes what was uploaded", async () => {
      const job = new AbortController();
      const { fake, d } = harness(submits(VALID));
      const held = fake.hold("uploadPdf");
      const task = rejection(runAgentTask(d, taskSpec(), { signal: job.signal }));
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
      job.abort();
      held.release();
      const err = await task;
      expect(err.code).toBe("aborted");
      expect(err.o.billed).toBeUndefined();
      expect(fake.methods()).toEqual(["uploadPdf", "deleteFile"]);
      expect(fake.files.size).toBe(0);
    });
  });

  describe("session create", () => {
    it("re-provisions once when the agent or environment is gone, then creates the session", async () => {
      const { fake, d, reprovision } = harness(submits(VALID));
      fake.fail("createSession", apiError(404));
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(reprovision).toHaveBeenCalledTimes(1);
      expect(fake.methods().filter((m) => m === "createSession")).toHaveLength(2);
    });

    it("re-provisions once when the create names an archived object", async () => {
      const { fake, d, reprovision } = harness(submits(VALID));
      fake.fail("createSession", apiError(400, "agent agent_2 is archived"));
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(reprovision).toHaveBeenCalledTimes(1);
    });

    it("fails without pausing when the session can't be created right after re-provisioning", async () => {
      const { fake, d, reprovision } = harness(submits(VALID));
      fake.fail("createSession", apiError(404), { times: 2 });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err).toMatchObject({ code: "server_error", message: "Anthropic couldn't start a session for the hosted agent (not found)." });
      expect(err.o).toMatchObject({ retryable: true });
      expect(err.o.pauseWorker ?? false).toBe(false);
      expect(reprovision).toHaveBeenCalledTimes(1);
      expect(fake.files.size).toBe(0);
    });

    it("maps other create errors like any session call", async () => {
      const { fake, d, reprovision } = harness(submits(VALID));
      fake.fail("createSession", apiError(403));
      expect((await rejection(runAgentTask(d, taskSpec()))).code).toBe("agent_unavailable");
      expect(reprovision).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("keeps the session and uploads with keepSessions and logs only the Console path", async () => {
      const { fake, d } = harness(submits(VALID), { keepSessions: true });
      await runAgentTask(d, taskSpec());
      expect(fake.uploads.map((u) => u.expiresInSeconds)).toEqual([604_800, 604_800]);
      expect(fake.methods()).not.toContain("deleteSession");
      expect(fake.methods()).not.toContain("deleteFile");
      expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
        "[agent] AGENT_KEEP_SESSIONS=1: kept session sesn_1 and its uploads. Console path: /workspaces/<workspace>/sessions/sesn_1");
    });

    it("sets the upload expiry from the session timeout, at least an hour", async () => {
      const { fake, d } = harness(submits(VALID), { sessionTimeoutMs: 2_700_000 });
      await runAgentTask(d, taskSpec({ files: [taskSpec().files[1]], content: (ids) => [{ type: "text", text: ids[0] }] }));
      expect(fake.uploads.map((u) => u.expiresInSeconds)).toEqual([3600]);
      const longer = harness(submits(VALID), { sessionTimeoutMs: 4_000_000 });
      await runAgentTask(longer.d, taskSpec());
      expect(longer.fake.uploads[0].expiresInSeconds).toBe(4900);
    });

    it("deletes the uploads when an upload fails halfway", async () => {
      const { fake, d } = harness(submits(VALID));
      fake.fail("uploadPdf", apiError(500), { match: ([name]) => name === "student-submission.pdf" });
      const err = await rejection(runAgentTask(d, taskSpec()));
      expect(err.code).toBe("server_error");
      expect(fake.methods()).toEqual(["uploadPdf", "uploadPdf", "deleteFile"]);
    });

    it("treats an already deleted session or upload as fine", async () => {
      const { fake, d } = harness(submits(VALID));
      fake.fail("deleteSession", apiError(404));
      fake.fail("deleteFile", apiError(404), { times: 2 });
      await expect(runAgentTask(d, taskSpec())).resolves.toMatchObject({ output: VALID });
      expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    });
  });
});

describe("sweepStaleSessions", () => {
  it("deletes only old sessions of the given agents that this process isn't running, and interrupts running ones", async () => {
    let clock = Date.parse("2026-10-07T08:00:00Z");
    const fake = createFakeManagedAgents({ now: () => clock });
    const p = fake.seedProvisioned();
    const create = async (role: "grade" | "scan") => (await fake.port.createSession({
      agent: { type: "agent", id: p.agents[role].id, version: 1 }, environment_id: p.environmentId,
    })).id;
    const oldIdle = await create("grade");
    const oldRunning = await create("grade");
    fake.sessions.get(oldRunning)!.status = "running";
    const oldActive = await create("grade");
    const otherAgent = await create("scan");
    clock += 3_600_000;
    const recent = await create("grade");
    fake.calls.length = 0;

    const deleted = await sweepStaleSessions({
      port: fake.port, agentIds: [p.agents.grade.id], createdBefore: new Date(clock - 60_000), active: new Set([oldActive]),
    });

    expect(deleted).toBe(1);
    expect([...fake.deletedSessions]).toEqual([oldIdle]);
    expect(fake.calls.filter((c) => c.method === "sendEvents").map((c) => [c.args[0], c.args[1]]))
      .toEqual([[oldRunning, [{ type: "user.interrupt" }]]]);
    for (const id of [oldActive, otherAgent, recent, oldRunning]) expect(fake.sessions.has(id)).toBe(true);
  });

  it("logs errors and never throws", async () => {
    const fake = createFakeManagedAgents();
    const p = fake.seedProvisioned();
    await fake.port.createSession({ agent: { type: "agent", id: p.agents.scan.id, version: 1 }, environment_id: p.environmentId });
    fake.fail("listSessions", apiError(500));
    fake.fail("deleteSession", apiError(500));
    await expect(sweepStaleSessions({
      port: fake.port, agentIds: [p.agents.grade.id, p.agents.scan.id], createdBefore: new Date(Date.now() + 60_000), active: new Set(),
    })).resolves.toBe(0);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(2);
  });
});

describe("toAgentUsage", () => {
  it("maps tokens, cache writes of both lifetimes, list cost in cents and whole seconds", () => {
    expect(toAgentUsage({
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 }, list_cost: { amount: "1234", currency: "USD" },
      active_seconds: 61.5,
    })).toEqual({
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 9 },
      cost: { listCostCents: 1234, activeSeconds: 62 },
    });
  });

  it("reads missing usage as zero and an unusable list cost as unknown", () => {
    const zero = {
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: { listCostCents: null, activeSeconds: 0 },
    };
    expect(toAgentUsage(null)).toEqual(zero);
    expect(toAgentUsage(undefined)).toEqual(zero);
    expect(toAgentUsage({ list_cost: null })).toEqual(zero);
    expect(toAgentUsage({ list_cost: { amount: "12.5", currency: "USD" } }).cost.listCostCents).toBeNull();
    expect(toAgentUsage({ list_cost: { amount: "12", currency: "EUR" as "USD" } }).cost.listCostCents).toBeNull();
  });
});
