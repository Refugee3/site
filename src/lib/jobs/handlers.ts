import { AiError, classifySdkError } from "@/lib/ai/errors";
import type { AiCallMeta, Grader } from "@/lib/ai/grader";
import type { GradingOutput } from "@/lib/ai/schemas";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { addAssignmentUsage, getAssignment, listSections } from "@/lib/db/repos/assignments";
import { hasActiveJob } from "@/lib/db/repos/jobs";
import { getKey, listKeyItems, replaceKeyItems, updateKey } from "@/lib/db/repos/keys";
import { getSubmission, markFailed, saveGradingResult, scheduleRetry, startGrading } from "@/lib/db/repos/submissions";
import { isAppError } from "@/lib/errors";
import { isKeyApproved, keyFingerprint, normalizeExtractedKey } from "@/lib/grading/key";
import { buildRefusedResult, reconcileGrading } from "@/lib/grading/reconcile";
import { decideFailure } from "@/lib/jobs/backoff";
import { rescoreSubmission } from "@/lib/services/submissions";
import { readDataFile, removeDataFile } from "@/lib/storage/files";
import type { AiUsage, AnswerKey, Assignment, Job, KeyItem, Section } from "@/lib/types";

// Handlers own every write to the job's target (submission or key); the worker owns every jobs-table write.

export type HandlerResult =
  | { kind: "done" }
  | { kind: "requeue"; runAfter: number; error: string; maxTokens?: number; refundAttempt: boolean }
  | { kind: "fail"; error: string }
  | { kind: "pause"; resumeAt: number; reason: string };

const DONE: HandlerResult = { kind: "done" };
const KEY_WAIT_MS = 60_000;
const WAITING_FOR_KEY = "Waiting for the answer key";
/** Extraction verdicts that mean the uploaded "key" is not one: its PDF must not be used as the teacher's reference. */
const NOT_A_KEY: ReadonlySet<string> = new Set(["student_work", "unrelated"]);

// ---------------------------------------------------------------------------------------------
// Grading one submission (handleGradeSubmission)

interface GradingContext {
  job: Job;
  submissionId: string;
  generation: number;
  assignment: Assignment;
  key: AnswerKey;
  items: KeyItem[];
  /** As sent to the AI; the result is reconciled against the sections at save time. */
  sections: Section[];
}

type Billed = NonNullable<AiError["o"]["billed"]>;

type GradingOutcome =
  | { kind: "graded"; output: GradingOutput; refs: string[]; meta: AiCallMeta }
  | { kind: "refused"; category: string | null; billed: Billed | null };

/**
 * Idempotent: a submission that is gone, already graded, or on a newer grading generation is left
 * alone, and a result is only stored for the generation that was read at the start.
 */
export async function handleGradeSubmission(job: Job, grader: Grader, signal: AbortSignal): Promise<HandlerResult> {
  const submission = getSubmission(job.targetId);
  if (!submission || (submission.status !== "queued" && submission.status !== "grading")) return DONE;
  const generation = submission.gradingGeneration;
  if (!startGrading(submission.id, generation)) return DONE;

  const assignment = getAssignment(submission.assignmentId);
  const key = getKey(submission.assignmentId);
  if (!assignment || !key) return DONE; // deleted since the claim
  const ctx: GradingContext = {
    job, submissionId: submission.id, generation, assignment, key,
    items: listKeyItems(assignment.id), sections: listSections(assignment.id),
  };

  if (!isKeyApproved(key, ctx.items.length)) {
    // Claiming only picks approved keys, but the teacher may have changed the key since.
    return scheduleRetry(submission.id, generation, WAITING_FOR_KEY)
      ? { kind: "requeue", runAfter: now() + KEY_WAIT_MS, error: WAITING_FOR_KEY, refundAttempt: true }
      : DONE;
  }

  const studentPdf = await readStoredPdf(submission.pdfPath);
  if (!studentPdf) {
    return markFailed(submission.id, generation, "file_missing", "The uploaded file is missing on the server.")
      ? { kind: "fail", error: "file_missing: student PDF not found" }
      : DONE;
  }
  // A PDF the extraction judged not to be a key (a student's paper, something unrelated) is never shown as the teacher's reference.
  const keyPdfPath = key.documentKind !== null && NOT_A_KEY.has(key.documentKind) ? null : key.sourcePdfPath;
  const keyPdf = keyPdfPath ? await readStoredPdf(keyPdfPath) : null;
  if (keyPdfPath && !keyPdf) console.warn(`[jobs] key PDF of assignment ${assignment.id} is missing; grading without it`);

  let outcome: GradingOutcome;
  try {
    const result = await grader.gradeSubmission(
      {
        assignment, teacherNotes: key.teacherNotes, sections: ctx.sections, items: ctx.items,
        keyPdf, studentPdf, studentPageCount: submission.pageCount,
      },
      { signal, maxTokens: job.maxTokens ?? getConfig().maxTokens },
    );
    outcome = { kind: "graded", output: result.output, refs: result.refs, meta: result.meta };
    recordUsage(assignment.id, result.meta.servedModel, result.meta.usage);
  } catch (e) {
    const err = classifySdkError(e);
    if (err.o.billed) recordUsage(assignment.id, err.o.billed.servedModel, err.o.billed.usage);
    if (!isFinalRefusal(job, err)) return gradingFailure(ctx, err);
    outcome = { kind: "refused", category: err.o.refusalCategory ?? null, billed: err.o.billed ?? null };
  }

  try {
    tx(() => saveOutcome(ctx, outcome));
  } catch (e) {
    // reconcileGrading rejects an answer that skips most items (retryable); anything else is a bug for the worker.
    if (e instanceof AiError) return gradingFailure(ctx, e);
    throw e;
  }
  return DONE;
}

/**
 * Runs inside tx(). Reconciles against the latest row and the current section list, so name or
 * section edits the teacher made during the AI call survive and apply.
 */
function saveOutcome(ctx: GradingContext, outcome: GradingOutcome): void {
  const latest = getSubmission(ctx.submissionId);
  if (!latest || latest.gradingGeneration !== ctx.generation) return; // regraded or deleted mid-call
  const sections = listSections(ctx.assignment.id);

  const reconciled = outcome.kind === "graded"
    ? reconcileGrading({
      output: outcome.output, refs: outcome.refs, items: ctx.items, sections, pageCount: latest.pageCount,
      current: latest, fallbackUsed: outcome.meta.fallbackUsed,
    })
    : buildRefusedResult({ items: ctx.items, current: latest, hasSections: sections.length > 0, category: outcome.category });
  const ai = outcome.kind === "graded"
    ? { aiModel: outcome.meta.servedModel, usage: outcome.meta.usage, aiOutputJson: JSON.stringify(outcome.output) }
    : { aiModel: outcome.billed?.servedModel ?? getConfig().model, usage: outcome.billed?.usage ?? null, aiOutputJson: null };

  const saved = saveGradingResult({
    submissionId: ctx.submissionId,
    generation: ctx.generation,
    keyRevision: ctx.key.revision,
    items: reconciled.items,
    fields: { ...reconciled.fields, status: reconciled.status, ...ai },
  });
  if (saved) rescoreSubmission(ctx.submissionId);
}

/** Records the failure on the submission; if the generation moved on (regrade or delete), the job is simply done. */
function gradingFailure(ctx: GradingContext, err: AiError): HandlerResult {
  const decision = decideFailure(ctx.job, err, failureLimits());
  const { submissionId: id, generation } = ctx;
  switch (decision.action) {
    case "requeue":
      return scheduleRetry(id, generation, decision.note)
        ? { kind: "requeue", runAfter: decision.runAfter, error: describe(err), maxTokens: decision.maxTokens, refundAttempt: decision.refundAttempt }
        : DONE;
    case "pause":
      return scheduleRetry(id, generation, `Paused: ${decision.reason}`)
        ? { kind: "pause", resumeAt: decision.resumeAt, reason: decision.reason }
        : DONE;
    case "fail":
      return markFailed(id, generation, err.code, decision.message) ? { kind: "fail", error: describe(err) } : DONE;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the answer key (handleExtractKey)

/**
 * Turns the key PDF into key items. Every key write is conditional on the key still being
 * `processing` with the PDF this run read, so a run superseded by a re-upload writes nothing.
 */
export async function handleExtractKey(job: Job, grader: Grader, signal: AbortSignal): Promise<HandlerResult> {
  const key = getKey(job.targetId);
  const assignment = getAssignment(job.targetId);
  if (!key || !assignment || key.status !== "processing") return DONE;
  const sourceSha = key.sourceSha256;

  const keyPdf = key.sourcePdfPath ? await readStoredPdf(key.sourcePdfPath) : null;
  if (!keyPdf || key.sourcePageCount === null) {
    return failKey(job.targetId, sourceSha, "The uploaded key file is missing; upload it again.");
  }

  const cfg = getConfig();
  let extraction: Awaited<ReturnType<Grader["extractKey"]>>;
  try {
    extraction = await grader.extractKey(
      { assignmentTitle: assignment.title, teacherNotes: key.teacherNotes, keyPdf, pageCount: key.sourcePageCount },
      { signal, maxTokens: job.maxTokens ?? cfg.maxTokens },
    );
  } catch (e) {
    const err = classifySdkError(e);
    if (err.o.billed) recordUsage(assignment.id, err.o.billed.servedModel, err.o.billed.usage);
    return extractionFailure(job, sourceSha, err);
  }

  const { output, meta } = extraction;
  recordUsage(assignment.id, meta.servedModel, meta.usage);
  const normalized = normalizeExtractedKey(output, { pageCount: key.sourcePageCount, maxItems: cfg.maxKeyItems });
  const notAKeyPdf = tx((): string | null => {
    const current = getKey(job.targetId);
    if (!current || !isSameRun(current, sourceSha)) return null;
    const aiFields = { documentKind: output.document_kind, aiNotes: normalized.aiNotes, aiModel: meta.servedModel, usage: meta.usage };
    if (normalized.fatal) {
      // A student's paper or an unrelated document must not stay attached as the key PDF (it would be sent
      // as the teacher's reference with every paper); reading it again cannot help either.
      const detach = NOT_A_KEY.has(output.document_kind) ? current.sourcePdfPath : null;
      const source = detach ? { sourcePdfPath: null, sourceFilename: null, sourceSha256: null, sourcePageCount: null } : {};
      updateKey(job.targetId, { ...aiFields, ...source, status: "failed", errorMessage: normalized.fatal });
      return detach;
    }
    const items = replaceKeyItems(job.targetId, normalized.items);
    updateKey(job.targetId, {
      ...aiFields,
      status: "ready",
      revision: current.revision + 1,
      approvedRevision: null, // the teacher must review AI-extracted items before anything is graded
      fingerprint: keyFingerprint(items, current.teacherNotes),
      errorMessage: null,
    });
    return null;
  });
  if (notAKeyPdf) await removeDataFile(notAKeyPdf);
  return DONE;
}

/** A retry or pause leaves the key `processing`; a re-upload meanwhile turns the requeue into a cancel (requeueJob). */
function extractionFailure(job: Job, sourceSha: string | null, err: AiError): HandlerResult {
  if (isFinalRefusal(job, err)) {
    return failKey(job.targetId, sourceSha, "The AI declined to read this document. Build the key manually.");
  }
  const decision = decideFailure(job, err, failureLimits());
  switch (decision.action) {
    case "requeue":
      return { kind: "requeue", runAfter: decision.runAfter, error: describe(err), maxTokens: decision.maxTokens, refundAttempt: decision.refundAttempt };
    case "pause":
      return { kind: "pause", resumeAt: decision.resumeAt, reason: decision.reason };
    case "fail":
      return failKey(job.targetId, sourceSha, decision.message);
  }
}

function failKey(assignmentId: string, sourceSha: string | null, message: string): HandlerResult {
  const failed = tx(() => {
    const current = getKey(assignmentId);
    if (!current || !isSameRun(current, sourceSha)) return false;
    updateKey(assignmentId, { status: "failed", errorMessage: message });
    return true;
  });
  return failed ? { kind: "fail", error: message } : DONE;
}

function isSameRun(key: AnswerKey, sourceSha: string | null): boolean {
  return key.status === "processing" && key.sourceSha256 === sourceSha;
}

// ---------------------------------------------------------------------------------------------
// Shared

/**
 * A refusal that stands: the handlers turn it into a result of their own (ai_refused paper, failed
 * key). A retryable refusal (the fallback model was unavailable) goes through decideFailure like any
 * temporary error until the job's attempts run out.
 */
function isFinalRefusal(job: Job, err: AiError): boolean {
  return err.code === "refusal" && !(err.o.retryable && job.attempts < job.maxAttempts);
}

/**
 * Marks the target failed after a handler threw on its last attempt. The worker calls it after
 * failJob, so any job still active for the target is a newer one (a regrade or re-upload): then the
 * target belongs to that job and is left alone.
 */
export function failTarget(job: Job, message: string): void {
  tx(() => {
    if (hasActiveJob(job.kind, job.targetId)) return;
    if (job.kind === "grade_submission") {
      const submission = getSubmission(job.targetId);
      if (submission) markFailed(submission.id, submission.gradingGeneration, "internal", message);
    } else if (getKey(job.targetId)?.status === "processing") {
      updateKey(job.targetId, { status: "failed", errorMessage: message });
    }
  });
}

/**
 * Adds a billed AI call to the assignment's usage totals (Settings). Accounting never fails the job:
 * a failed write is logged, since retrying would only bill the call again.
 */
function recordUsage(assignmentId: string, model: string, usage: AiUsage): void {
  try {
    addAssignmentUsage(assignmentId, model, usage);
  } catch (e) {
    console.error(`[jobs] could not record AI usage for assignment ${assignmentId}`, e);
  }
}

/** The stored PDF, or null when the file is gone; other I/O errors propagate to the worker. */
async function readStoredPdf(rel: string): Promise<Uint8Array | null> {
  try {
    return await readDataFile(rel);
  } catch (e) {
    if (isAppError(e) && e.code === "file_missing") return null;
    throw e;
  }
}

function failureLimits(): { now: number; maxTokens: number; maxTokensCeiling: number } {
  const cfg = getConfig();
  return { now: now(), maxTokens: cfg.maxTokens, maxTokensCeiling: cfg.maxTokensCeiling };
}

/** For jobs.last_error (never shown to students). */
function describe(err: AiError): string {
  return `${err.code}: ${err.message}`;
}
