import type { AiError, AiErrorCode } from "@/lib/ai/errors";
import type { Job, JobKind } from "@/lib/types";

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 1_800_000;
const PAUSE_MS = 5 * 60_000;

const RETRY_NOTE = "Retrying after a temporary AI error";
const LARGER_BUDGET_NOTE = "Retrying with more room for the AI's answer";
const LARGER_SPENDING_CAP_NOTE = "Retrying with a larger spending cap for the hosted agent";

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
  | { action: "pause"; resumeAt: number; reason: string; code: AiErrorCode };

/**
 * What to do after a failed AI call. `job.attempts` already counts the current run.
 * Final refusals never get here: the handlers turn them into a result of their own. A retryable
 * refusal (the fallback model was unavailable) arrives only while attempts remain and is requeued.
 */
export function decideFailure(
  job: Job,
  err: AiError,
  o: { now: number; maxTokens: number; maxTokensCeiling: number; rand?: () => number },
): FailureDecision {
  if (err.code === "max_tokens" || err.code === "budget_reached") {
    // One retry with the largest budget; the same budget again would only stop at the same place. The hosted agent
    // doubles its spending cap for a call that asks for more than the default max tokens.
    if ((job.maxTokens ?? o.maxTokens) >= o.maxTokensCeiling) return { action: "fail", message: failureMessage(err.code, job.kind) };
    const note = err.code === "max_tokens" ? LARGER_BUDGET_NOTE : LARGER_SPENDING_CAP_NOTE;
    return { action: "requeue", runAfter: o.now, maxTokens: o.maxTokensCeiling, refundAttempt: true, note };
  }
  if (err.o.pauseWorker) {
    return { action: "pause", resumeAt: o.now + PAUSE_MS, reason: pauseReason(err.code), code: err.code };
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
      return "Anthropic rejected the API key. Replace it in Settings.";
    case "model_not_found":
      return "The AI model isn't available with this API key. Check Settings → AI model.";
    case "billing":
      return "Billing problem — check the plan and credits in the Anthropic Console";
    case "agent_unavailable":
      return "The hosted agent isn't available with this API key. Open Settings to set it up again or switch to Direct API.";
    default:
      return `The AI service is unavailable (${code})`;
  }
}

function failureMessage(code: AiErrorCode, kind: JobKind): string {
  if (kind === "split_scan") return splitFailureMessage(code);
  switch (code) {
    case "max_tokens":
      return kind === "grade_submission"
        ? "The AI's answer was too long even at the maximum size. Grade this paper manually."
        : "The AI's answer was too long even at the maximum size. Build the key manually or split the assignment.";
    case "budget_reached":
      return kind === "grade_submission"
        ? "The hosted agent reached its spending cap for this paper, even at double the cap. Grade it yourself, or raise "
          + "AGENT_BUDGET_GRADE_USD on the server."
        : "The hosted agent reached its spending cap reading this key, even at double the cap. Build the key yourself, or raise "
          + "AGENT_BUDGET_EXTRACT_USD on the server.";
    case "request_too_large":
      return "This PDF is too large for the AI.";
    case "invalid_output":
      return "The AI returned an unusable answer several times.";
    default:
      return `The AI service failed (${code}).`;
  }
}

/** Every way out of a failed split leads to "every N pages", which needs no AI. */
function splitFailureMessage(code: AiErrorCode): string {
  switch (code) {
    case "max_tokens":
      return "The AI's answer was too long. Split the scan every N pages instead.";
    case "budget_reached":
      return "The hosted agent reached its spending cap. Split the scan every N pages instead, or raise AGENT_BUDGET_SCAN_USD on the "
        + "server.";
    case "request_too_large":
      return "Part of this scan is too large for the AI. Split it every N pages instead.";
    case "invalid_output":
      return "The AI returned an unusable answer several times. Split the scan every N pages instead.";
    default:
      return `The AI service failed (${code}). Try again or split the scan every N pages.`;
  }
}
