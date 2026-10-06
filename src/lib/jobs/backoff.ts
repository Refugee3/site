import type { AiError, AiErrorCode } from "@/lib/ai/errors";
import type { Job, JobKind } from "@/lib/types";

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 1_800_000;
const PAUSE_MS = 5 * 60_000;

const RETRY_NOTE = "Retrying after a temporary AI error";
const LARGER_BUDGET_NOTE = "Retrying with more room for the AI's answer";

/**
 * When to run the next attempt: about 30 s, 2 min, 8 min, … (±20 % jitter, capped at 30 min),
 * and never before the API's retry-after.
 */
export function nextRunAfter(now: number, attempts: number, retryAfterMs: number | null, rand: () => number = Math.random): number {
  const exponential = Math.min(BASE_DELAY_MS * 4 ** (Math.max(attempts, 1) - 1), MAX_DELAY_MS);
  const jittered = exponential * (0.8 + 0.4 * rand());
  // run_after is an INTEGER column in a STRICT table, so the delay must be a whole number.
  return now + Math.round(Math.max(retryAfterMs ?? 0, jittered));
}

export type FailureDecision =
  | { action: "requeue"; runAfter: number; maxTokens?: number; refundAttempt: boolean; note: string }
  | { action: "fail"; message: string /* teacher-readable */ }
  | { action: "pause"; resumeAt: number; reason: string };

/**
 * What to do after a failed AI call (§7). `job.attempts` already counts the current run.
 * Refusals never get here: the handlers turn them into a result of their own.
 */
export function decideFailure(
  job: Job,
  err: AiError,
  o: { now: number; maxTokens: number; maxTokensCeiling: number; rand?: () => number },
): FailureDecision {
  if (err.code === "max_tokens") {
    // One retry with the largest budget; the same budget again would only stop at the same place.
    if ((job.maxTokens ?? o.maxTokens) >= o.maxTokensCeiling) return { action: "fail", message: failureMessage(err.code, job.kind) };
    return { action: "requeue", runAfter: o.now, maxTokens: o.maxTokensCeiling, refundAttempt: true, note: LARGER_BUDGET_NOTE };
  }
  if (err.o.pauseWorker) {
    return { action: "pause", resumeAt: o.now + PAUSE_MS, reason: pauseReason(err.code) };
  }
  if (err.o.retryable && job.attempts < job.maxAttempts) {
    const runAfter = nextRunAfter(o.now, job.attempts, err.o.retryAfterMs ?? null, o.rand);
    return { action: "requeue", runAfter, refundAttempt: false, note: RETRY_NOTE };
  }
  return { action: "fail", message: failureMessage(err.code, job.kind) };
}

function pauseReason(code: AiErrorCode): string {
  switch (code) {
    case "auth":
      return "API key rejected — check ANTHROPIC_API_KEY";
    case "model_not_found":
      return "Model not found — check ANTHROPIC_MODEL";
    default:
      return `The AI service is unavailable (${code})`;
  }
}

function failureMessage(code: AiErrorCode, kind: JobKind): string {
  switch (code) {
    case "max_tokens":
      return kind === "grade_submission"
        ? "The AI's answer was too long even at the maximum size. Grade this paper manually."
        : "The AI's answer was too long even at the maximum size. Build the key manually or split the assignment.";
    case "request_too_large":
      return "This PDF is too large for the AI.";
    case "invalid_output":
      return "The AI returned an unusable answer several times.";
    default:
      return `The AI service failed (${code}).`;
  }
}
