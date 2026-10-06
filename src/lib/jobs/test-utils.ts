// Tests only: scripted graders and job-table inspection for the jobs and services suites.
import { createFakeGrader } from "@/lib/ai/fake";
import type { AiCallMeta, GradeInput, Grader } from "@/lib/ai/grader";
import { itemRefs } from "@/lib/ai/prompts";
import type { GradingOutput } from "@/lib/ai/schemas";
import { getDb } from "@/lib/db/connection";
import { createWorker } from "@/lib/jobs/worker";
import type { JobKind, JobStatus } from "@/lib/types";

const instantFake = createFakeGrader({ delayMs: 0 });

export const FAKE_META: AiCallMeta = {
  requestedModel: "fake",
  servedModel: "fake",
  fallbackUsed: false,
  stopReason: "end_turn",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  durationMs: 0,
};

/** A grader whose methods default to the instant fake grader; override one to script a test. */
export function scriptedGrader(o: Partial<Pick<Grader, "extractKey" | "gradeSubmission">> = {}): Grader {
  return {
    mode: "fake",
    extractKey: o.extractKey ?? instantFake.extractKey,
    gradeSubmission: o.gradeSubmission ?? instantFake.gradeSubmission,
  };
}

/** A grader that answers each paper with `answer(refs, input)`. */
export function answeringGrader(answer: (refs: string[], input: GradeInput) => GradingOutput): Grader {
  return scriptedGrader({
    async gradeSubmission(input) {
      const refs = itemRefs(input.items.length);
      return { output: answer(refs, input), refs, keyPdfIncluded: false, meta: FAKE_META };
    },
  });
}

/** Runs every job that is due now, one at a time; returns how many ran. */
export async function drainQueue(grader: Grader = instantFake): Promise<number> {
  const worker = createWorker({ grader, concurrency: 1, pollMs: 1000 });
  let ran = 0;
  while (await worker.runOnce()) ran++;
  return ran;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface JobRow {
  id: number;
  kind: JobKind;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: number;
  max_tokens: number | null;
  last_error: string | null;
}

/** Every job row for a target, oldest first. */
export function jobRows(targetId: string): JobRow[] {
  return getDb()
    .prepare("SELECT id, kind, status, priority, attempts, max_attempts, run_after, max_tokens, last_error FROM jobs WHERE target_id = ? ORDER BY id")
    .all(targetId) as JobRow[];
}
