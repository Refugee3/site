import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionErrorEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { describe, expect, it } from "vitest";
import { AiError } from "../errors";
import { environmentNameTaken, provisioningError, sessionCallError, sessionErrorToAiError, teacherMessageFor } from "./errors";
import { apiError } from "./test-fake";

const UNREACHABLE = (code: string) => `Anthropic couldn't be reached just now (${code}). It's tried again before the next paper.`;

function sessionError(type: BetaManagedAgentsSessionErrorEvent["error"]["type"], retry: "retrying" | "exhausted" | "terminal" = "exhausted",
  message = "details"): BetaManagedAgentsSessionErrorEvent {
  return { id: "sevt_1", type: "session.error", processed_at: "2026-10-07T00:00:00Z",
    error: { type, message, retry_status: { type: retry } } as BetaManagedAgentsSessionErrorEvent["error"] };
}

describe("provisioningError", () => {
  it.each([
    ["401", apiError(401), "auth", "Anthropic rejected the API key. Replace it above."],
    ["403", apiError(403), "agent_unavailable", "This API key isn't allowed to use Claude Managed Agents. In the Anthropic Console, check "
      + "that Managed Agents is available to your organization and workspace, or switch to Direct API."],
    ["404", apiError(404), "agent_unavailable", "Claude Managed Agents isn't available to this API key. Check your organization's access "
      + "in the Anthropic Console, or switch to Direct API."],
    ["402", apiError(402), "billing", "Anthropic reports a billing problem. Check the plan and credits in the Anthropic Console."],
    ["credit balance too low", apiError(400, "Your credit balance is too low to access the Anthropic API."), "billing",
      "Anthropic reports a billing problem. Check the plan and credits in the Anthropic Console."],
    ["400", apiError(400, "tools.1.input_schema: unsupported keyword"), "agent_unavailable",
      "Anthropic refused the hosted agent's settings: tools.1.input_schema: unsupported keyword. Switch to Direct API and report this."],
    ["422", apiError(422, "system: too long"), "agent_unavailable",
      "Anthropic refused the hosted agent's settings: system: too long. Switch to Direct API and report this."],
  ] as const)("%s → %s, pausing the worker", (_name, error, code, message) => {
    const err = provisioningError(error);
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
    expect(err.o).toMatchObject({ retryable: false, pauseWorker: true });
    expect(teacherMessageFor(err)).toBe(message);
  });

  it("cuts a refused setting's API message to 200 characters", () => {
    const err = provisioningError(apiError(400, "x".repeat(500)));
    expect(err.message).toBe(`Anthropic refused the hosted agent's settings: ${"x".repeat(200)}. Switch to Direct API and report this.`);
  });

  it.each([
    ["409 that conflicts again", apiError(409), "server_error"],
    ["429", apiError(429), "rate_limited"],
    ["500", apiError(500), "server_error"],
    ["529", Anthropic.APIError.generate(529, { error: { type: "overloaded_error" } }, undefined, new Headers()), "overloaded"],
    ["connection", new Anthropic.APIConnectionError({ message: "socket hang up" }), "connection"],
    ["timeout", new Anthropic.APIConnectionTimeoutError(), "timeout"],
  ] as const)("%s → %s, retried before the next paper", (_name, error, code) => {
    const err = provisioningError(error);
    expect(err.code).toBe(code);
    expect(err.o.retryable).toBe(true);
    expect(err.o.pauseWorker ?? false).toBe(false);
    expect(err.message).toBe(UNREACHABLE(code));
    expect(teacherMessageFor(err)).toBe(UNREACHABLE(code));
  });

  it("keeps a rate limit's retry-after", () => {
    const err = provisioningError(new Anthropic.RateLimitError(429, {}, "x", new Headers({ "retry-after": "3" })));
    expect(err.o.retryAfterMs).toBe(3000);
  });

  it("passes AiErrors through and treats an abort as aborted", () => {
    const taken = environmentNameTaken("pdf-autograder-abc");
    expect(provisioningError(taken)).toBe(taken);
    expect(provisioningError(new Anthropic.APIUserAbortError()).code).toBe("aborted");
  });

  it("explains an environment name that is taken by an unusable environment", () => {
    const err = environmentNameTaken("pdf-autograder-a1b2c3d4e5f6");
    expect(err.code).toBe("agent_unavailable");
    expect(err.o).toMatchObject({ retryable: false, pauseWorker: true });
    expect(teacherMessageFor(err)).toBe("An environment named \"pdf-autograder-a1b2c3d4e5f6\" already exists in your Anthropic workspace but "
      + "can't be used (it may be archived). Delete it in the Anthropic Console, then press Set up again, or switch to Direct API.");
  });
});

describe("sessionCallError", () => {
  it("maps 401 and 403 to pausing errors with the teacher's text", () => {
    expect(sessionCallError(apiError(401))).toMatchObject({ code: "auth", message: "Anthropic rejected the API key. Replace it above." });
    const forbidden = sessionCallError(apiError(403));
    expect(forbidden.code).toBe("agent_unavailable");
    expect(forbidden.o.pauseWorker).toBe(true);
  });

  it("treats a 404 as a vanished session, retried later", () => {
    const err = sessionCallError(apiError(404));
    expect(err).toMatchObject({ code: "server_error", message: "The hosted agent's session disappeared." });
    expect(err.o.retryable).toBe(true);
    expect(err.o.pauseWorker ?? false).toBe(false);
  });

  it.each([
    [apiError(400), "bad_request", false],
    [apiError(422), "bad_request", false],
    [apiError(413), "request_too_large", false],
    [apiError(429), "rate_limited", true],
    [apiError(503), "server_error", true],
    [new Anthropic.APIConnectionError({ message: "reset" }), "connection", true],
    [new Anthropic.APIUserAbortError(), "aborted", true],
  ] as const)("otherwise classifies like the direct path (%#)", (error, code, retryable) => {
    const err = sessionCallError(error);
    expect(err.code).toBe(code);
    expect(err.o.retryable).toBe(retryable);
  });
});

describe("sessionErrorToAiError", () => {
  it("uses the fallback without an event", () => {
    const err = sessionErrorToAiError(null, "The hosted agent stopped after repeated errors.");
    expect(err).toMatchObject({ code: "server_error", message: "The hosted agent stopped after repeated errors." });
    expect(err.o.retryable).toBe(true);
  });

  it.each([
    ["model_overloaded_error", "overloaded", true],
    ["model_rate_limited_error", "rate_limited", true],
    ["model_request_failed_error", "server_error", true],
    ["unknown_error", "server_error", true],
    ["mcp_connection_failed_error", "server_error", true],
    ["credential_host_unreachable_error", "server_error", true],
    ["repository_clone_error", "server_error", true],
    ["billing_error", "billing", false],
  ] as const)("%s → %s", (type, code, retryable) => {
    const err = sessionErrorToAiError(sessionError(type), "fallback");
    expect(err.code).toBe(code);
    expect(err.o.retryable).toBe(retryable);
    expect(err.o.pauseWorker ?? false).toBe(code === "billing");
  });

  it("has no retry delay for a rate limit and keeps the event's message", () => {
    const err = sessionErrorToAiError(sessionError("model_rate_limited_error", "exhausted", "slow down"), "fallback");
    expect(err.o.retryAfterMs).toBeNull();
    expect(err.message).toBe("slow down");
    expect(sessionErrorToAiError(sessionError("unknown_error", "terminal", " "), "fallback").message).toBe("fallback");
  });
});

describe("teacherMessageFor", () => {
  it("falls back to a generic setup message for other codes", () => {
    expect(teacherMessageFor(new AiError("unknown", "boom", { retryable: true })))
      .toBe("Setting up the hosted agent failed (unknown). Try again, or switch to Direct API.");
    expect(teacherMessageFor(new AiError("billing", "Anthropic reports a billing problem.", { retryable: false })))
      .toBe("Anthropic reports a billing problem.");
  });
});
