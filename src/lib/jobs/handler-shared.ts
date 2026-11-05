import { type AgentCallCost, type AiError, type AiErrorCode } from "@/lib/ai/errors";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { addAssignmentUsage } from "@/lib/db/repos/assignments";
import { isAppError } from "@/lib/errors";
import { readDataFile } from "@/lib/storage/files";
import type { AiUsage, Job } from "@/lib/types";

// What every job handler shares (handlers.ts, one-pass.ts).

/** `throttled`: a rate limit or overload; the worker then slows down (see createWorker). */
export type HandlerResult =
  | { kind: "done" }
  | { kind: "requeue"; runAfter: number; error: string; maxTokens?: number; refundAttempt: boolean; throttled?: boolean }
  | { kind: "fail"; error: string }
  | { kind: "pause"; resumeAt: number; reason: string; code: AiErrorCode };

export const DONE: HandlerResult = { kind: "done" };
export const KEY_WAIT_MS = 60_000;
export const WAITING_FOR_KEY = "Waiting for the answer key";
/** Extraction verdicts that mean the uploaded "key" is not one: its PDF must not be used as the teacher's reference. */
export const NOT_A_KEY: ReadonlySet<string> = new Set(["student_work", "unrelated"]);

/**
 * A refusal that stands: the handlers turn it into a result of their own (ai_refused paper, failed
 * key). A retryable refusal (the fallback model was unavailable) goes through decideFailure like any
 * temporary error until the job's attempts run out.
 */
export function isFinalRefusal(job: Job, err: AiError): boolean {
  return err.code === "refusal" && !(err.o.retryable && job.attempts < job.maxAttempts);
}

/**
 * Adds a billed AI call to the assignment's usage totals (Settings); `agent` is a hosted-agent session's cost beside its
 * tokens. Accounting never fails the job: a failed write is logged, since retrying would only bill the call again.
 */
export function recordUsage(assignmentId: string, model: string, usage: AiUsage, agent?: AgentCallCost | null): void {
  try {
    addAssignmentUsage(assignmentId, model, usage, agent ?? undefined);
  } catch (e) {
    console.error(`[jobs] could not record AI usage for assignment ${assignmentId}`, e);
  }
}

/** The stored PDF, or null when the file is gone; other I/O errors propagate to the worker. */
export async function readStoredPdf(rel: string): Promise<Uint8Array | null> {
  try {
    return await readDataFile(rel);
  } catch (e) {
    if (isAppError(e) && e.code === "file_missing") return null;
    throw e;
  }
}

export function failureLimits(): { now: number; maxTokens: number; maxTokensCeiling: number } {
  const cfg = getConfig();
  return { now: now(), maxTokens: cfg.maxTokens, maxTokensCeiling: cfg.maxTokensCeiling };
}

/** For jobs.last_error (never shown to students). */
export function describe(err: AiError): string {
  return `${err.code}: ${err.message}`;
}

export function addUsage(total: AiUsage | null, u: AiUsage): AiUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + u.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + u.outputTokens,
    cacheReadTokens: (total?.cacheReadTokens ?? 0) + u.cacheReadTokens,
    cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
  };
}
