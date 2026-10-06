import { describe, expect, it } from "vitest";
import { AiError, type AiErrorCode, type AiErrorOptions } from "@/lib/ai/errors";
import { decideFailure, nextRunAfter } from "@/lib/jobs/backoff";
import type { Job } from "@/lib/types";

const NOW = 1_700_000_000_000;
const LIMITS = { now: NOW, maxTokens: 64_000, maxTokensCeiling: 128_000, rand: () => 0.5 };

function makeJob(o: Partial<Job> = {}): Job {
  return {
    id: 1, kind: "grade_submission", targetId: "s1", assignmentId: "a1", status: "running", priority: 10, attempts: 1,
    maxAttempts: 4, runAfter: NOW, maxTokens: null, lastError: null, createdAt: NOW, updatedAt: NOW, finishedAt: null, ...o,
  };
}

function aiError(code: AiErrorCode, o: Partial<AiErrorOptions> = {}): AiError {
  return new AiError(code, `${code} happened`, { retryable: false, ...o });
}

describe("nextRunAfter", () => {
  it("backs off 30 s, 2 min, 8 min … with ±20 % jitter", () => {
    expect(nextRunAfter(NOW, 1, null, () => 0.5)).toBe(NOW + 30_000);
    expect(nextRunAfter(NOW, 2, null, () => 0.5)).toBe(NOW + 120_000);
    expect(nextRunAfter(NOW, 3, null, () => 0.5)).toBe(NOW + 480_000);
    expect(nextRunAfter(NOW, 1, null, () => 0)).toBe(NOW + 24_000);
    expect(nextRunAfter(NOW, 1, null, () => 1)).toBe(NOW + 36_000);
  });

  it("caps the delay at 30 minutes before jitter", () => {
    expect(nextRunAfter(NOW, 9, null, () => 0.5)).toBe(NOW + 1_800_000);
  });

  it("never runs before the API's retry-after", () => {
    expect(nextRunAfter(NOW, 1, 90_000, () => 0.5)).toBe(NOW + 90_000);
    expect(nextRunAfter(NOW, 1, 1_000, () => 0.5)).toBe(NOW + 30_000);
  });

  it("returns whole milliseconds (run_after is an INTEGER column)", () => {
    expect(Number.isInteger(nextRunAfter(NOW, 1, null, () => 0.123456789))).toBe(true);
  });
});

describe("decideFailure", () => {
  it("row 1: retries a max_tokens stop once at the ceiling, at once and without using up an attempt", () => {
    expect(decideFailure(makeJob(), aiError("max_tokens", { retryable: true }), LIMITS)).toEqual({
      action: "requeue", runAfter: NOW, maxTokens: 128_000, refundAttempt: true, note: "Retrying with more room for the AI's answer",
    });
  });

  it("row 1: a max_tokens stop already at the ceiling fails with a message for the teacher", () => {
    const job = makeJob({ maxTokens: 128_000 });
    expect(decideFailure(job, aiError("max_tokens", { retryable: true }), LIMITS)).toEqual({
      action: "fail", message: "The AI's answer was too long even at the maximum size. Grade this paper manually.",
    });
    const keyJob = makeJob({ kind: "extract_key", maxTokens: 128_000 });
    expect(decideFailure(keyJob, aiError("max_tokens", { retryable: true }), LIMITS)).toMatchObject({
      action: "fail", message: expect.stringContaining("Build the key manually"),
    });
  });

  it("row 2: pauses the worker for 5 minutes on a rejected key or an unknown model", () => {
    expect(decideFailure(makeJob(), aiError("auth", { pauseWorker: true }), LIMITS)).toEqual({
      action: "pause", resumeAt: NOW + 300_000, reason: "API key rejected — check ANTHROPIC_API_KEY",
    });
    expect(decideFailure(makeJob(), aiError("model_not_found", { pauseWorker: true }), LIMITS)).toEqual({
      action: "pause", resumeAt: NOW + 300_000, reason: "Model not found — check ANTHROPIC_MODEL",
    });
  });

  it("row 2 wins over the attempt count: a bad key on the last attempt still pauses", () => {
    const job = makeJob({ attempts: 4 });
    expect(decideFailure(job, aiError("auth", { pauseWorker: true }), LIMITS).action).toBe("pause");
  });

  it("row 3: requeues a retryable error with backoff while attempts remain", () => {
    expect(decideFailure(makeJob({ attempts: 2 }), aiError("overloaded", { retryable: true }), LIMITS)).toEqual({
      action: "requeue", runAfter: NOW + 120_000, refundAttempt: false, note: "Retrying after a temporary AI error",
    });
  });

  it("row 3: honours retry-after", () => {
    const err = aiError("rate_limited", { retryable: true, retryAfterMs: 600_000 });
    expect(decideFailure(makeJob(), err, LIMITS)).toMatchObject({ action: "requeue", runAfter: NOW + 600_000 });
  });

  it("row 4: fails a retryable error once attempts are exhausted", () => {
    expect(decideFailure(makeJob({ attempts: 4 }), aiError("overloaded", { retryable: true }), LIMITS)).toEqual({
      action: "fail", message: "The AI service failed (overloaded).",
    });
  });

  it("row 4: fails a non-retryable error at once, with a message per code", () => {
    expect(decideFailure(makeJob(), aiError("bad_request"), LIMITS)).toEqual({ action: "fail", message: "The AI service failed (bad_request)." });
    expect(decideFailure(makeJob(), aiError("request_too_large"), LIMITS)).toEqual({ action: "fail", message: "This PDF is too large for the AI." });
    expect(decideFailure(makeJob({ attempts: 4 }), aiError("invalid_output", { retryable: true }), LIMITS)).toEqual({
      action: "fail", message: "The AI returned an unusable answer several times.",
    });
  });
});
