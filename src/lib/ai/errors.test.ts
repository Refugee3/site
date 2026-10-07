import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AiError, classifySdkError } from "./errors";

const headers = (init: Record<string, string> = {}) => new Headers(init);

describe("classifySdkError", () => {
  it("returns an AiError unchanged", () => {
    const err = new AiError("max_tokens", "too long", { retryable: true });
    expect(classifySdkError(err)).toBe(err);
  });

  it.each([
    ["APIUserAbortError", new Anthropic.APIUserAbortError(), "aborted", true],
    ["APIConnectionTimeoutError", new Anthropic.APIConnectionTimeoutError(), "timeout", true],
    ["APIConnectionError", new Anthropic.APIConnectionError({ message: "socket hang up" }), "connection", true],
    ["BadRequestError", new Anthropic.BadRequestError(400, {}, "bad", headers()), "bad_request", false],
    ["UnprocessableEntityError", new Anthropic.UnprocessableEntityError(422, {}, "bad", headers()), "bad_request", false],
    ["413", new Anthropic.APIError(413, {}, "too big", headers()), "request_too_large", false],
    ["529", Anthropic.APIError.generate(529, { error: { type: "overloaded_error" } }, undefined, headers()), "overloaded", true],
    ["InternalServerError", new Anthropic.InternalServerError(500, {}, "boom", headers()), "server_error", true],
    ["503", Anthropic.APIError.generate(503, {}, "unavailable", headers()), "server_error", true],
    ["408", Anthropic.APIError.generate(408, {}, "timeout", headers()), "server_error", true],
    ["ConflictError (409)", new Anthropic.ConflictError(409, {}, "conflict", headers()), "server_error", true],
    ["other APIError", new Anthropic.APIError(418, {}, "teapot", headers()), "unknown", false],
    ["AnthropicError", new Anthropic.AnthropicError("stream ended without a message"), "invalid_output", true],
    ["anything else", new TypeError("x is undefined"), "unknown", true],
  ] as const)("%s → %s", (_name, error, code, retryable) => {
    const ai = classifySdkError(error);
    expect(ai).toBeInstanceOf(AiError);
    expect(ai.code).toBe(code);
    expect(ai.o.retryable).toBe(retryable);
    expect(ai.o.pauseWorker ?? false).toBe(false);
  });

  it.each([
    ["AuthenticationError", new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", headers()), "auth"],
    ["PermissionDeniedError", new Anthropic.PermissionDeniedError(403, {}, "forbidden", headers()), "auth"],
    ["NotFoundError", new Anthropic.NotFoundError(404, {}, "model: claude-nope", headers()), "model_not_found"],
  ] as const)("%s pauses the worker", (_name, error, code) => {
    const ai = classifySdkError(error);
    expect(ai.code).toBe(code);
    expect(ai.o.pauseWorker).toBe(true);
    expect(ai.o.retryable).toBe(false);
  });

  describe("billing problems pause the worker instead of failing every paper", () => {
    it.each([
      ["402 billing_error", Anthropic.APIError.generate(402, { type: "error", error: { type: "billing_error", message: "Payment required" } },
        undefined, headers())],
      ["402 without a body", Anthropic.APIError.generate(402, undefined, "payment required", headers())],
      ["billing_error after the stream started (no status)",
        new Anthropic.APIError(undefined, { error: { type: "billing_error" } }, undefined, headers(), "billing_error")],
      ["400 credit balance too low", Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } },
      undefined, headers())],
    ] as const)("%s → billing", (_name, error) => {
      const ai = classifySdkError(error);
      expect(ai.code).toBe("billing");
      expect(ai.o.pauseWorker).toBe(true);
      expect(ai.o.retryable).toBe(false);
    });

    it("keeps other 400s per-request", () => {
      const ai = classifySdkError(Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error",
        message: "The PDF specified was not valid." } }, undefined, headers()));
      expect(ai.code).toBe("bad_request");
      expect(ai.o.pauseWorker ?? false).toBe(false);
    });
  });

  describe("rate limits", () => {
    it("reads retry-after in seconds", () => {
      const ai = classifySdkError(new Anthropic.RateLimitError(429, {}, "x", headers({ "retry-after": "7" })));
      expect(ai.code).toBe("rate_limited");
      expect(ai.o.retryable).toBe(true);
      expect(ai.o.retryAfterMs).toBe(7000);
    });

    it("prefers retry-after-ms", () => {
      const ai = classifySdkError(new Anthropic.RateLimitError(429, {}, "x", headers({ "retry-after-ms": "1500", "retry-after": "7" })));
      expect(ai.o.retryAfterMs).toBe(1500);
    });

    it("has no delay without a usable header", () => {
      expect(classifySdkError(new Anthropic.RateLimitError(429, {}, "x", headers())).o.retryAfterMs).toBeNull();
      const dated = new Anthropic.RateLimitError(429, {}, "x", headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }));
      expect(classifySdkError(dated).o.retryAfterMs).toBeNull();
    });
  });

  describe("errors after the stream started (no HTTP status)", () => {
    it.each([
      ["overloaded_error", "overloaded"],
      ["rate_limit_error", "rate_limited"],
      ["api_error", "server_error"],
    ] as const)("%s → %s, retryable", (type, code) => {
      const ai = classifySdkError(new Anthropic.APIError(undefined, { error: { type } }, undefined, new Headers(), type));
      expect(ai.code).toBe(code);
      expect(ai.o.retryable).toBe(true);
    });
  });

  it("keeps the SDK message", () => {
    expect(classifySdkError(new Anthropic.BadRequestError(400, undefined, "max_tokens is too large", headers())).message)
      .toContain("max_tokens is too large");
  });

  it("classifies thrown non-errors", () => {
    const ai = classifySdkError("boom");
    expect(ai.code).toBe("unknown");
    expect(ai.message).toBe("boom");
  });
});
