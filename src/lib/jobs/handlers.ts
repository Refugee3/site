import { type AgentCallCost, AiError, classifySdkError, type AiErrorCode } from "@/lib/ai/errors";
import type { AiCallMeta, Grader, ScanPreviousPage } from "@/lib/ai/grader";
import type { GradingOutput } from "@/lib/ai/schemas";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { addAssignmentUsage, getAssignment, listSections } from "@/lib/db/repos/assignments";
import { hasActiveJob } from "@/lib/db/repos/jobs";
import { getKey, listKeyItems, replaceKeyItems, updateKey } from "@/lib/db/repos/keys";
import { getScan, updateSplittingScan } from "@/lib/db/repos/scans";
import { getAiModel } from "@/lib/db/repos/settings";
import { getSubmission, markFailed, saveGradingResult, scheduleRetry, startGrading } from "@/lib/db/repos/submissions";
import { isAppError } from "@/lib/errors";
import { isKeyApproved, keyFingerprint, normalizeExtractedKey } from "@/lib/grading/key";
import { buildRefusedResult, reconcileGrading } from "@/lib/grading/reconcile";
import {
  keyPageCountHint, normalizeScanReadings, proposeLayout, SCAN_CHUNK_MAX_BYTES, SCAN_CHUNK_MAX_PAGES,
} from "@/lib/grading/split";
import { decideFailure } from "@/lib/jobs/backoff";
import { loadGuidance, type AssignmentGuidance } from "@/lib/services/guidance";
import { autoGradeCleanSplit } from "@/lib/services/scans";
import { rescoreSubmission } from "@/lib/services/submissions";
import { readDataFile, removeDataFile } from "@/lib/storage/files";
import { extractPageSets } from "@/lib/storage/pdf";
import type { AiUsage, AnswerKey, Assignment, Job, KeyItem, Scan, ScanPageReading, Section } from "@/lib/types";

// Handlers own every write to the job's target (submission or key); the worker owns every jobs-table write.

/** `throttled`: a rate limit or overload; the worker then slows down (see createWorker). */
export type HandlerResult =
  | { kind: "done" }
  | { kind: "requeue"; runAfter: number; error: string; maxTokens?: number; refundAttempt: boolean; throttled?: boolean }
  | { kind: "fail"; error: string }
  | { kind: "pause"; resumeAt: number; reason: string; code: AiErrorCode };

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
  /** The teacher's preferences and lessons as they were when the job started; the grading records their fingerprint. */
  guidance: AssignmentGuidance;
  /** The engine of the grader the job runs on, stored with the grading. */
  engine: Grader["engine"];
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
  const items = listKeyItems(assignment.id);
  const ctx: GradingContext = {
    job, submissionId: submission.id, generation, assignment, key, items, sections: listSections(assignment.id),
    guidance: loadGuidance(assignment, items), engine: grader.engine,
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
        keyPdf, studentPdf, studentPageCount: submission.pageCount, guidance: ctx.guidance.guidance,
      },
      { signal, maxTokens: job.maxTokens ?? getConfig().maxTokens },
    );
    outcome = { kind: "graded", output: result.output, refs: result.refs, meta: result.meta };
    recordUsage(assignment.id, result.meta.servedModel, result.meta.usage, result.meta.agent);
  } catch (e) {
    const err = classifySdkError(e);
    if (err.o.billed) recordUsage(assignment.id, err.o.billed.servedModel, err.o.billed.usage, err.o.billed.agent);
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
    : { aiModel: outcome.billed?.servedModel ?? getAiModel(), usage: outcome.billed?.usage ?? null, aiOutputJson: null };

  const saved = saveGradingResult({
    submissionId: ctx.submissionId,
    generation: ctx.generation,
    keyRevision: ctx.key.revision,
    guidanceFingerprint: ctx.guidance.fingerprint,
    items: reconciled.items,
    fields: { ...reconciled.fields, status: reconciled.status, ...ai, aiEngine: ctx.engine },
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
        ? {
          kind: "requeue", runAfter: decision.runAfter, error: describe(err), maxTokens: decision.maxTokens, refundAttempt: decision.refundAttempt,
          throttled: decision.throttled,
        }
        : DONE;
    case "pause":
      return scheduleRetry(id, generation, `Paused: ${decision.reason}`)
        ? { kind: "pause", resumeAt: decision.resumeAt, reason: decision.reason, code: decision.code }
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
    if (err.o.billed) recordUsage(assignment.id, err.o.billed.servedModel, err.o.billed.usage, err.o.billed.agent);
    return extractionFailure(job, sourceSha, err);
  }

  const { output, meta } = extraction;
  recordUsage(assignment.id, meta.servedModel, meta.usage, meta.agent);
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
      processingFinishedAt: now(),
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
      return {
        kind: "requeue", runAfter: decision.runAfter, error: describe(err), maxTokens: decision.maxTokens, refundAttempt: decision.refundAttempt,
        throttled: decision.throttled,
      };
    case "pause":
      return { kind: "pause", resumeAt: decision.resumeAt, reason: decision.reason, code: decision.code };
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
// Splitting a whole-class scan (handleSplitScan)

interface SplitRun {
  job: Job;
  scanId: string;
  /** Every scan write is conditional on the scan still splitting on this generation. */
  generation: number;
}

type ScanChunk = { pages: number[]; pdf: Uint8Array } | { error: string };

/** Why a split run stopped before reading every page; the first one wins, except that a superseded run writes nothing. */
type SplitStop =
  | { kind: "superseded" }
  | { kind: "chunk"; error: string }
  | { kind: "ai"; err: AiError }
  | { kind: "crash"; error: unknown };

/** What the parallel readers of one run share. JavaScript runs them one step at a time, so plain fields are safe. */
interface SplitState {
  readings: Array<ScanPageReading | null>;
  /** Pages read, or being read by one of the readers. */
  claimed: boolean[];
  usage: AiUsage | null;
  /** At least one chunk was read and saved by this run. */
  progress: boolean;
  stop: SplitStop | null;
}

/**
 * Has the AI describe the scan's pages chunk by chunk, up to SCAN_SPLIT_PARALLEL chunks at a time, then proposes where each
 * paper starts. Each chunk's readings are saved as soon as it is read (in any order), so a requeued run reads only the pages
 * still unread; "every N pages", "try the AI again" and deleting the scan supersede a run, whose writes then change nothing.
 * When a chunk fails, no new chunk starts; the chunks being read finish and are saved. A clean proposal is graded at once.
 */
export async function handleSplitScan(job: Job, grader: Grader, signal: AbortSignal): Promise<HandlerResult> {
  const scan = getScan(job.targetId);
  if (!scan || scan.status !== "splitting") return DONE;
  const assignment = getAssignment(scan.assignmentId);
  const key = getKey(scan.assignmentId);
  if (!assignment || !key) return DONE; // deleted since the claim
  const run: SplitRun = { job, scanId: scan.id, generation: scan.splitGeneration };
  // Scans queued before the split clock existed start it now.
  if (scan.splitStartedAt === null && !updateSplittingScan(run.scanId, run.generation, { splitStartedAt: now() })) return DONE;
  const items = listKeyItems(assignment.id);
  const sections = listSections(assignment.id);
  const keyPageCount = keyPageCountHint(key, items);
  const readings: Array<ScanPageReading | null> = scan.readings.length === scan.pageCount
    ? [...scan.readings]
    : new Array<ScanPageReading | null>(scan.pageCount).fill(null);
  const state: SplitState = { readings, claimed: readings.map((r) => r !== null), usage: scan.usage, progress: false, stop: null };
  const cfg = getConfig();
  // One scan file read and cut at a time: at most one copy of the scan plus one chunk per reader is held.
  const cutOneAtATime = serialized();

  const readChunks = async (): Promise<void> => {
    for (;;) {
      if (state.stop) return;
      const claimed = claimPages(state);
      if (!claimed) return;
      const chunk = await cutOneAtATime(() => nextChunk(scan, claimed));
      if ("error" in chunk) {
        state.stop ??= { kind: "chunk", error: chunk.error };
        return;
      }
      // Pages left out of a chunk that was too large go back to the pool.
      for (const page of claimed) if (!chunk.pages.includes(page)) state.claimed[page - 1] = false;
      if (currentStop(state)) return;
      let read: { meta: AiCallMeta; readings: ScanPageReading[] };
      try {
        const result = await grader.readScanPages(
          {
            assignmentTitle: assignment.title, sections, items, keyPageCount,
            chunkPdf: chunk.pdf, firstPage: chunk.pages[0], chunkPageCount: chunk.pages.length, totalPages: scan.pageCount,
            // What is known when the call starts: a chunk read in parallel with the one before it gets no previous page.
            previousPage: previousPage(state.readings, chunk.pages[0]),
          },
          { signal, maxTokens: job.maxTokens ?? cfg.maxTokens },
        );
        recordUsage(assignment.id, result.meta.servedModel, result.meta.usage, result.meta.agent);
        read = { meta: result.meta, readings: normalizeScanReadings(result.output, { chunkPageCount: chunk.pages.length }) };
      } catch (e) {
        const err = classifySdkError(e);
        if (err.o.billed) recordUsage(assignment.id, err.o.billed.servedModel, err.o.billed.usage, err.o.billed.agent);
        state.stop ??= { kind: "ai", err };
        return;
      }
      if (currentStop(state)?.kind === "superseded") return;
      chunk.pages.forEach((page, i) => {
        state.readings[page - 1] = read.readings[i];
      });
      state.usage = addUsage(state.usage, read.meta.usage);
      const saved = updateSplittingScan(run.scanId, run.generation, {
        readings: state.readings, pagesRead: state.readings.filter((r) => r !== null).length, statusNote: null,
        aiModel: read.meta.servedModel, usage: state.usage,
      });
      if (!saved) {
        state.stop = { kind: "superseded" };
        return;
      }
      state.progress = true;
    }
  };

  const readers = Math.max(1, cfg.scanSplitParallel);
  await Promise.all(Array.from({ length: readers }, () => readChunks().catch((error: unknown) => {
    state.stop ??= { kind: "crash", error };
  })));

  const stop = currentStop(state);
  if (stop) {
    switch (stop.kind) {
      case "superseded":
        return DONE;
      case "chunk":
        return failScan(run, stop.error);
      case "ai":
        return splitFailure(run, stop.err, state.progress);
      case "crash":
        throw stop.error; // the worker retries with backoff; the pages read stay saved
    }
  }

  const layout = proposeLayout(readings.filter((r) => r !== null), { keyPageCount });
  const proposed = updateSplittingScan(run.scanId, run.generation, {
    status: "review", layout, proposedLayout: layout, statusNote: null, splitFinishedAt: now(),
  });
  if (proposed) await autoGradeCleanSplit(run.scanId);
  return DONE;
}

/** Read through a call: readers set it while others await, which TypeScript's narrowing of `state.stop` does not see. */
function currentStop(state: SplitState): SplitStop | null {
  return state.stop;
}

/** Claims the next run of unread pages no reader has, at most SCAN_CHUNK_MAX_PAGES (1-based pages); null when none is left. */
function claimPages(state: SplitState): number[] | null {
  const start = state.claimed.indexOf(false);
  if (start === -1) return null;
  const pages: number[] = [];
  for (let i = start; i < state.claimed.length && !state.claimed[i] && pages.length < SCAN_CHUNK_MAX_PAGES; i++) {
    state.claimed[i] = true;
    pages.push(i + 1);
  }
  return pages;
}

/** Runs the given tasks one after another, in the order they were handed in. */
function serialized(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** The reading of the scan page before `firstPage` (1-based), so the AI can judge whether the chunk's first page continues it. */
function previousPage(readings: Array<ScanPageReading | null>, firstPage: number): ScanPreviousPage | null {
  const r = firstPage > 1 ? readings[firstPage - 2] : null;
  if (!r || !r.reported) return null;
  return { page: firstPage - 1, kind: r.kind, studentName: r.studentName, worksheetPage: r.worksheetPage, pageMarker: r.pageMarker };
}

/**
 * The PDF of `claimed` (1-based, consecutive, unread), or of its first half, quarter … while it is over
 * SCAN_CHUNK_MAX_BYTES. The scan's bytes are dropped on return: only the chunk is held across the AI call.
 */
async function nextChunk(scan: Scan, claimed: number[]): Promise<ScanChunk> {
  let pages = claimed;
  const bytes = await readStoredPdf(scan.pdfPath);
  if (!bytes) return { error: "The uploaded scan is missing on the server. Upload it again." };
  for (;;) {
    let pdf: Uint8Array;
    try {
      [pdf] = await extractPageSets(bytes, [pages]);
    } catch (e) {
      if (isAppError(e) && e.code === "invalid_pdf") return { error: "The scan could not be read. Upload it again." };
      throw e;
    }
    if (pdf.byteLength <= SCAN_CHUNK_MAX_BYTES) return { pages, pdf };
    if (pages.length === 1) {
      return { error: `Page ${pages[0]} of the scan is too large to send to the AI. Split the scan every N pages instead.` };
    }
    pages = pages.slice(0, Math.ceil(pages.length / 2));
  }
}

/**
 * A run that read at least one chunk does not count as a used attempt: a long scan that keeps making progress
 * never runs out of attempts, also on its last one.
 */
function splitFailure(run: SplitRun, err: AiError, progress: boolean): HandlerResult {
  const job = progress ? { ...run.job, attempts: run.job.attempts - 1 } : run.job;
  if (isFinalRefusal(job, err)) return failScan(run, "The AI declined to read this scan. Split it every N pages instead.");
  const decision = decideFailure(job, err, failureLimits());
  switch (decision.action) {
    case "requeue":
      return noteSplit(run, decision.note)
        ? {
          kind: "requeue", runAfter: decision.runAfter, error: describe(err), maxTokens: decision.maxTokens,
          refundAttempt: decision.refundAttempt || progress, throttled: decision.throttled,
        }
        : DONE;
    case "pause":
      return noteSplit(run, `Paused: ${decision.reason}`)
        ? { kind: "pause", resumeAt: decision.resumeAt, reason: decision.reason, code: decision.code }
        : DONE;
    case "fail":
      return failScan(run, decision.message, describe(err));
  }
}

function noteSplit(run: SplitRun, note: string): boolean {
  return updateSplittingScan(run.scanId, run.generation, { statusNote: note });
}

/** `message` is for the teacher; `lastError` for jobs.last_error. A superseded run fails nothing. */
function failScan(run: SplitRun, message: string, lastError: string = message): HandlerResult {
  const failed = updateSplittingScan(run.scanId, run.generation, { status: "failed", errorMessage: message, statusNote: null });
  return failed ? { kind: "fail", error: lastError } : DONE;
}

function addUsage(total: AiUsage | null, u: AiUsage): AiUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + u.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + u.outputTokens,
    cacheReadTokens: (total?.cacheReadTokens ?? 0) + u.cacheReadTokens,
    cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
  };
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
    switch (job.kind) {
      case "grade_submission": {
        const submission = getSubmission(job.targetId);
        if (submission) markFailed(submission.id, submission.gradingGeneration, "internal", message);
        return;
      }
      case "extract_key":
        if (getKey(job.targetId)?.status === "processing") updateKey(job.targetId, { status: "failed", errorMessage: message });
        return;
      case "split_scan": {
        const scan = getScan(job.targetId);
        if (scan) updateSplittingScan(scan.id, scan.splitGeneration, { status: "failed", errorMessage: message, statusNote: null });
        return;
      }
    }
  });
}

/**
 * Adds a billed AI call to the assignment's usage totals (Settings); `agent` is a hosted-agent session's cost beside its
 * tokens. Accounting never fails the job: a failed write is logged, since retrying would only bill the call again.
 */
function recordUsage(assignmentId: string, model: string, usage: AiUsage, agent?: AgentCallCost | null): void {
  try {
    addAssignmentUsage(assignmentId, model, usage, agent ?? undefined);
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
