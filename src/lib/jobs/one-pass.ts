import { PDF_BYTE_BUDGET } from "@/lib/ai/claude";
import { AiError, classifySdkError } from "@/lib/ai/errors";
import type { Grader, PacketChunkInput } from "@/lib/ai/grader";
import { itemRefs } from "@/lib/ai/prompts";
import type { PacketOutput } from "@/lib/ai/schemas";
import { now } from "@/lib/clock";
import { type AppConfig, getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { getAssignment, listSections, startGradingBatchForOnePass } from "@/lib/db/repos/assignments";
import { getKey, listKeyItems } from "@/lib/db/repos/keys";
import { updateSplittingScan } from "@/lib/db/repos/scans";
import { countSubmissions, findBySha, insertSubmission, saveGradingResult } from "@/lib/db/repos/submissions";
import { AppError, isAppError } from "@/lib/errors";
import { statusFromFlags } from "@/lib/flags";
import { isKeyApproved } from "@/lib/grading/key";
import {
  type ChunkPaper, chunkPageCount, hasOnePassProgress, interpretChunk, planChunk, smallerChunk, splitUsage,
} from "@/lib/grading/packet";
import { reconcileGrading } from "@/lib/grading/reconcile";
import { keyPageCountHint, SCAN_CHUNK_MAX_BYTES } from "@/lib/grading/split";
import { newId, newToken, sha256Hex } from "@/lib/ids";
import { decideFailure } from "@/lib/jobs/backoff";
import {
  addUsage, describe, DONE, failureLimits, type HandlerResult, isFinalRefusal, KEY_WAIT_MS, NOT_A_KEY, readStoredPdf, recordUsage,
  WAITING_FOR_KEY,
} from "@/lib/jobs/handler-shared";
import { enqueueGrade, PRIORITY } from "@/lib/jobs/queue";
import { formatPageRanges } from "@/lib/scan-layout";
import { loadGuidance } from "@/lib/services/guidance";
import { rescoreSubmission } from "@/lib/services/submissions";
import { removeDataFile, writeFileAtomic } from "@/lib/storage/files";
import { submissionPdfRel } from "@/lib/storage/paths";
import { CutTooLargeError, extractPageSets } from "@/lib/storage/pdf";
import {
  type AiUsage, type AnswerKey, type Assignment, FLAG_CODES, type Job, type KeyItem, type OnePassPendingChunk, type OnePassProgress,
  type Scan, type Submission,
} from "@/lib/types";

// Grading a whole-class scan in one pass (split mode "one_pass", run by the scan's split_scan job): the scan is read in
// chunks of consecutive pages, in order, and each AI call both finds the papers of its chunk and grades them, so every page
// is read once. Each paper is cut from the scan and stored already graded, through the same reconcile → saveGradingResult →
// rescore path as a paper graded on its own (which it can be later: a regrade grades it the usual way).
//
// Crash safety: a chunk's AI answer is saved on the scan (onePass.pending) before any of its papers is stored, and each paper
// is stored in one transaction with the scan's progress, so a run that stops anywhere resumes where it stopped without
// paying for a call again (except one that finished in the moment before its answer was saved).

/** How today's split path is run, for a scan whose engine can't grade in one pass (the hosted agent). */
export type SplitFirst = (job: Job, grader: Grader, signal: AbortSignal) => Promise<HandlerResult>;

/** Output budget per paper of a chunk, by whether the AI writes notes. */
const TOKENS_PER_PAPER = { notes: 16_000, lean: 8_000 } as const;
/** The key PDF goes with every chunk only when at least this much of the request's PDF budget is left for the pages. */
const MIN_CHUNK_BYTES = 8 * 1_048_576;

export const AGENT_FALLBACK_NOTE = "The hosted agent can't grade in one pass, so the AI splits this scan first; each paper is then graded on its own.";
const AGENT_CANT_RESUME = "The hosted agent can't grade in one pass. Choose Direct API under Settings → Grader, then try again; "
  + "the papers graded so far stay.";

interface Run {
  job: Job;
  scanId: string;
  /** Every scan write is conditional on the scan still splitting on this generation. */
  generation: number;
  assignmentId: string;
}

interface Context {
  run: Run;
  scan: Scan;
  assignment: Assignment;
  key: AnswerKey;
  items: KeyItem[];
  keyPageCount: number | null;
  cfg: AppConfig;
}

/** Why storing a chunk's papers stopped; null: they are all stored. */
type StoreStop = { kind: "superseded" } | { kind: "fail"; message: string };

class Superseded extends Error {}

export async function handleOnePassScan(
  job: Job, grader: Grader, signal: AbortSignal, scan: Scan, splitFirst: SplitFirst,
): Promise<HandlerResult> {
  const run: Run = { job, scanId: scan.id, generation: scan.splitGeneration, assignmentId: scan.assignmentId };
  const gradeChunk = grader.gradePacketChunk;
  if (!gradeChunk) {
    // The hosted agent was chosen after the upload: split first, as it would have been at upload, unless papers were graded.
    if (hasOnePassProgress(scan.onePass)) return failScan(run, AGENT_CANT_RESUME);
    if (!updateSplittingScan(run.scanId, run.generation, { splitMode: "auto", onePass: null, statusNote: AGENT_FALLBACK_NOTE })) return DONE;
    return splitFirst(job, grader, signal);
  }

  const assignment = getAssignment(scan.assignmentId);
  const key = getKey(scan.assignmentId);
  if (!assignment || !key) return DONE; // deleted since the claim
  if (scan.splitStartedAt === null && !updateSplittingScan(run.scanId, run.generation, { splitStartedAt: now() })) return DONE;
  const items = listKeyItems(assignment.id);
  if (!isKeyApproved(key, items.length)) {
    return noteScan(run, WAITING_FOR_KEY)
      ? { kind: "requeue", runAfter: now() + KEY_WAIT_MS, error: WAITING_FOR_KEY, refundAttempt: true }
      : DONE;
  }
  try {
    startGradingBatchForOnePass(assignment.id, now());
  } catch (e) {
    console.error(`[jobs] could not start the grading batch of assignment ${assignment.id}`, e);
  }

  const cfg = getConfig();
  const ctx: Context = { run, scan, assignment, key, items, keyPageCount: keyPageCountHint(key, items), cfg };
  // Loaded once: every chunk of this run is sent the same guidance, so they all share one cached prefix.
  const guidance = loadGuidance(assignment, items);
  const sections = listSections(assignment.id);
  // A PDF the extraction judged not to be a key is never shown as the teacher's reference (as when grading one paper).
  const keyPdfPath = key.documentKind !== null && NOT_A_KEY.has(key.documentKind) ? null : key.sourcePdfPath;
  const storedKeyPdf = keyPdfPath ? await readStoredPdf(keyPdfPath) : null;
  // The key PDF goes with every chunk or with none, so the prefix stays the same; chunks are cut to fit beside it.
  const keyPdf = storedKeyPdf !== null && storedKeyPdf.byteLength <= PDF_BYTE_BUDGET - MIN_CHUNK_BYTES ? storedKeyPdf : null;
  const chunkByteLimit = Math.min(SCAN_CHUNK_MAX_BYTES, PDF_BYTE_BUDGET - (keyPdf?.byteLength ?? 0));

  let progress: OnePassProgress = scan.onePass ?? emptyProgress();
  let usage = scan.usage;
  /** At least one chunk was finished by this run. */
  let ranChunk = false;
  for (;;) {
    if (progress.pending) {
      const stored = await storePendingChunk(ctx, progress);
      if ("kind" in stored) return stored.kind === "superseded" ? DONE : failScan(run, stored.message);
      progress = stored;
      ranChunk = true;
      continue;
    }
    const size = chunkPageCount({ keyPageCount: ctx.keyPageCount, maxPages: cfg.onePassChunkPages, override: progress.maxChunkPages });
    const planned = planChunk(progress.nextPage, scan.pageCount, size);
    if (!planned) break;
    const chunk = await cutChunk(scan, planned, chunkByteLimit, ctx.keyPageCount);
    if ("error" in chunk) return failScan(run, chunk.error);
    const chunkPages = chunk.lastPage - chunk.firstPage + 1;

    const input: PacketChunkInput = {
      assignment, teacherNotes: key.teacherNotes, sections, items, keyPdf, guidance: guidance.guidance, writeNotes: assignment.writeNotes,
      chunkPdf: chunk.pdf, firstPage: chunk.firstPage, chunkPageCount: chunkPages, totalPages: scan.pageCount,
      keyPageCount: ctx.keyPageCount,
    };
    let result: Awaited<ReturnType<NonNullable<Grader["gradePacketChunk"]>>>;
    try {
      result = await gradeChunk.call(grader, input, {
        signal, maxTokens: job.maxTokens ?? chunkMaxTokens(cfg, chunkPages, ctx.keyPageCount, assignment.writeNotes),
      });
      recordUsage(assignment.id, result.meta.servedModel, result.meta.usage, result.meta.agent);
      // Checked before it is saved, so an unusable answer is retried like any failed call.
      interpretChunk(result.output, {
        firstPage: chunk.firstPage, lastPage: chunk.lastPage, totalPages: scan.pageCount, previousEndedCleanly: progress.endedCleanly,
      });
    } catch (e) {
      const err = classifySdkError(e);
      if (err.o.billed) recordUsage(assignment.id, err.o.billed.servedModel, err.o.billed.usage, err.o.billed.agent);
      return chunkFailure(ctx, err, { ranChunk, chunkPages, progress });
    }

    const pending: OnePassPendingChunk = {
      firstPage: chunk.firstPage,
      lastPage: chunk.lastPage,
      output: result.output,
      items: items.map((item) => ({ id: item.id, label: item.label })),
      keyRevision: key.revision,
      guidanceFingerprint: guidance.fingerprint,
      servedModel: result.meta.servedModel,
      fallbackUsed: result.meta.fallbackUsed,
      engine: grader.engine,
      usage: result.meta.usage,
      stored: 0,
    };
    usage = addUsage(usage, result.meta.usage);
    progress = { ...progress, pending };
    if (!updateSplittingScan(run.scanId, run.generation, { onePass: progress, usage, aiModel: result.meta.servedModel, statusNote: null })) {
      return DONE;
    }
  }

  updateSplittingScan(run.scanId, run.generation, {
    status: "done", statusNote: null, errorMessage: null, pagesRead: scan.pageCount, splitFinishedAt: now(),
  });
  return DONE;
}

function emptyProgress(): OnePassProgress {
  return { nextPage: 1, endedCleanly: true, chunks: 0, maxChunkPages: null, papers: [], skipped: [], pending: null };
}

/** Room for the AI's answer for a chunk: per expected paper (2 pages each when the key doesn't tell), within the configured limits. */
function chunkMaxTokens(cfg: AppConfig, pages: number, keyPageCount: number | null, writeNotes: boolean): number {
  const papers = Math.ceil(pages / Math.max(1, keyPageCount ?? 2));
  const perPaper = writeNotes ? TOKENS_PER_PAPER.notes : TOKENS_PER_PAPER.lean;
  return Math.min(cfg.maxTokensCeiling, Math.max(cfg.maxTokens, papers * perPaper));
}

/**
 * The PDF of the planned pages, or of fewer (about half, in whole papers) while it is over `byteLimit`. The scan's bytes are
 * dropped on return: only the chunk is held across the AI call.
 */
async function cutChunk(
  scan: Scan, planned: { firstPage: number; lastPage: number }, byteLimit: number, keyPageCount: number | null,
): Promise<{ firstPage: number; lastPage: number; pdf: Uint8Array } | { error: string }> {
  const bytes = await readStoredPdf(scan.pdfPath);
  if (!bytes) return { error: "The uploaded scan is missing on the server. Upload it again." };
  let { lastPage } = planned;
  for (;;) {
    let pdf: Uint8Array;
    try {
      [pdf] = await extractPageSets(bytes, [pageRange(planned.firstPage, lastPage)]);
    } catch (e) {
      if (isAppError(e) && e.code === "invalid_pdf") return { error: "The scan could not be read. Upload it again." };
      throw e;
    }
    if (pdf.byteLength <= byteLimit) return { firstPage: planned.firstPage, lastPage, pdf };
    const smaller = smallerChunk(lastPage - planned.firstPage + 1, keyPageCount);
    if (smaller === null) return { error: `Page ${planned.firstPage} of the scan is too large to send to the AI.` };
    lastPage = planned.firstPage + smaller - 1;
  }
}

/**
 * Stores the papers of the pending chunk not stored yet, then moves on to the next chunk. Returns the new progress, or why it
 * stopped (the scan was superseded, or a paper can't be stored).
 */
async function storePendingChunk(ctx: Context, progress: OnePassProgress): Promise<OnePassProgress | StoreStop> {
  const pending = progress.pending!;
  const { run, scan } = ctx;
  const interpreted = interpretChunk(pending.output as PacketOutput, {
    firstPage: pending.firstPage, lastPage: pending.lastPage, totalPages: scan.pageCount, previousEndedCleanly: progress.endedCleanly,
  });
  const shares = splitUsage(pending.usage, interpreted.papers.length);
  let current = progress;
  const todo = interpreted.papers.slice(pending.stored);
  if (todo.length > 0) {
    const bytes = await readStoredPdf(scan.pdfPath);
    if (!bytes) return { kind: "fail", message: "The uploaded scan is missing on the server. Upload it again." };
    let pdfs: Uint8Array[];
    try {
      pdfs = await extractPageSets(bytes, todo.map((paper) => pageRange(paper.firstPage, paper.lastPage)), {
        maxBytesPerSet: ctx.cfg.maxUploadBytes,
      });
    } catch (e) {
      if (!(e instanceof CutTooLargeError)) throw e;
      const paper = todo[e.index];
      return {
        kind: "fail",
        message: `The paper on pages ${formatPageRanges(pageRange(paper.firstPage, paper.lastPage))} is too large to store. Rescan at a lower `
          + "resolution.",
      };
    }
    for (const [i, paper] of todo.entries()) {
      const stored = await storePaper(ctx, current, paper, pdfs[i], shares[pending.stored + i]);
      if ("kind" in stored) return stored;
      current = stored;
    }
  }

  const next: OnePassProgress = {
    ...current,
    nextPage: interpreted.nextPage,
    endedCleanly: interpreted.endedCleanly,
    chunks: current.chunks + 1,
    skipped: [...current.skipped, ...interpreted.skipped],
    pending: null,
  };
  if (!updateSplittingScan(run.scanId, run.generation, { onePass: next, pagesRead: interpreted.nextPage - 1 })) {
    return { kind: "superseded" };
  }
  return next;
}

/**
 * Stores one paper and records it in the scan's progress, in one transaction: as a teacher submission already graded, or,
 * when the same pages are already in the assignment, only as a duplicate. A paper whose answer can't be used (most items
 * missing) is stored queued and graded on its own.
 */
async function storePaper(
  ctx: Context, progress: OnePassProgress, paper: ChunkPaper, pdf: Uint8Array, usage: AiUsage,
): Promise<OnePassProgress | StoreStop> {
  const { run, scan } = ctx;
  const pending = progress.pending!;
  const sha = sha256Hex(pdf);
  const record = (submissionId: string | null): { progress: OnePassProgress; counts: { createdCount: number; duplicateCount: number } } => {
    const next: OnePassProgress = {
      ...progress,
      papers: [...progress.papers, { firstPage: paper.firstPage, lastPage: paper.lastPage, submissionId, flagged: paper.boundaryNotes.length > 0 }],
      pending: { ...pending, stored: pending.stored + 1 },
    };
    const created = next.papers.filter((p) => p.submissionId !== null).length;
    return { progress: next, counts: { createdCount: created, duplicateCount: next.papers.length - created } };
  };
  const saveProgress = (submissionId: string | null): OnePassProgress => {
    const { progress: next, counts } = record(submissionId);
    if (!updateSplittingScan(run.scanId, run.generation, { onePass: next, ...counts })) throw new Superseded();
    return next;
  };
  const duplicate = (): OnePassProgress | StoreStop => {
    try {
      return tx(() => saveProgress(null));
    } catch (e) {
      if (e instanceof Superseded) return { kind: "superseded" };
      throw e;
    }
  };

  if (findBySha(run.assignmentId, sha) || ctx.key.sourceSha256 === sha) return duplicate();
  const id = newId();
  const pdfPath = submissionPdfRel(run.assignmentId, id);
  await writeFileAtomic(pdfPath, pdf);
  try {
    return tx(() => {
      const next = saveProgress(id);
      const assignment = getAssignment(run.assignmentId);
      if (!assignment) throw new Superseded();
      if (countSubmissions(run.assignmentId) >= assignment.maxSubmissions) {
        throw new AppError("submission_limit", "This assignment has reached its submission limit. Raise it in the assignment's "
          + "Settings, then try again; the papers graded so far stay.");
      }
      const submission = insertSubmission({
        id,
        assignmentId: run.assignmentId,
        source: "teacher",
        receiptToken: newToken(),
        pdfPath,
        originalFilename: `${scan.originalFilename} (pages ${formatPageRanges(pageRange(paper.firstPage, paper.lastPage))})`,
        contentSha256: sha,
        byteSize: pdf.byteLength,
        pageCount: paper.lastPage - paper.firstPage + 1,
      });
      saveGrading(submission, paper, pending, usage);
      return next;
    });
  } catch (e) {
    await removeDataFile(pdfPath);
    if (e instanceof Superseded) return { kind: "superseded" };
    // The same pages arrived by another way in the meantime.
    if (isAppError(e) && e.code === "duplicate") return duplicate();
    if (isAppError(e) && e.code === "submission_limit") return { kind: "fail", message: e.message };
    throw e;
  }
}

/**
 * Runs inside the transaction that inserted `submission`: its grading, as the grade handler saves one (reconciled against
 * the key items the chunk was graded with), plus the paper_boundary flag and the reasons for it in the teacher's notes.
 */
function saveGrading(submission: Submission, paper: ChunkPaper, pending: OnePassPendingChunk, usage: AiUsage): void {
  let reconciled: ReturnType<typeof reconcileGrading>;
  try {
    reconciled = reconcileGrading({
      output: paper.output, refs: itemRefs(pending.items.length), items: pending.items, sections: listSections(submission.assignmentId),
      pageCount: submission.pageCount, current: submission, fallbackUsed: pending.fallbackUsed,
    });
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    // Most items missing for this paper: it is graded on its own instead.
    enqueueGrade(submission.id, submission.assignmentId, PRIORITY.teacher);
    return;
  }
  const flagged = paper.boundaryNotes.length > 0;
  const flags = flagged ? FLAG_CODES.filter((code) => code === "paper_boundary" || reconciled.fields.flags.includes(code)) : reconciled.fields.flags;
  const teacherSummary = [reconciled.fields.teacherSummary, ...paper.boundaryNotes].filter((line) => line !== "").join("\n");
  const saved = saveGradingResult({
    submissionId: submission.id,
    generation: submission.gradingGeneration,
    keyRevision: pending.keyRevision,
    guidanceFingerprint: pending.guidanceFingerprint,
    items: reconciled.items,
    fields: {
      ...reconciled.fields, flags, teacherSummary, status: statusFromFlags(flags, null),
      aiModel: pending.servedModel, usage, aiOutputJson: JSON.stringify(paper.output), aiEngine: pending.engine,
    },
  });
  if (saved) rescoreSubmission(submission.id);
}

/**
 * A failed chunk call. When the AI's answer was too long, later chunks are made smaller (about half, in whole papers) and the
 * run goes on at once. A run that finished at least one chunk does not count as a used attempt, so a long scan that keeps
 * making progress never runs out of attempts.
 */
function chunkFailure(ctx: Context, err: AiError, o: { ranChunk: boolean; chunkPages: number; progress: OnePassProgress }): HandlerResult {
  const { run } = ctx;
  if (err.code === "max_tokens") {
    const smaller = smallerChunk(o.chunkPages, ctx.keyPageCount);
    if (smaller !== null) {
      const note = "Reading fewer pages at a time: the AI's answer didn't fit";
      const saved = updateSplittingScan(run.scanId, run.generation, { onePass: { ...o.progress, maxChunkPages: smaller }, statusNote: note });
      return saved ? { kind: "requeue", runAfter: now(), error: describe(err), refundAttempt: true } : DONE;
    }
  }
  const job = o.ranChunk ? { ...run.job, attempts: run.job.attempts - 1 } : run.job;
  const graded = hasOnePassProgress(o.progress) || o.ranChunk;
  if (isFinalRefusal(job, err)) return failScan(run, failureMessage("refusal", graded), describe(err));
  const decision = decideFailure(job, err, failureLimits());
  switch (decision.action) {
    case "requeue":
      return noteScan(run, decision.note)
        ? {
          kind: "requeue", runAfter: decision.runAfter, error: describe(err), maxTokens: decision.maxTokens,
          refundAttempt: decision.refundAttempt || o.ranChunk, throttled: decision.throttled,
        }
        : DONE;
    case "pause":
      return noteScan(run, `Paused: ${decision.reason}`)
        ? { kind: "pause", resumeAt: decision.resumeAt, reason: decision.reason, code: decision.code }
        : DONE;
    case "fail":
      return failScan(run, failureMessage(err.code, graded), describe(err));
  }
}

/** For the teacher; `graded`: papers were graded already (they stay, and trying again goes on from there). */
function failureMessage(code: AiError["code"], graded: boolean): string {
  const what = (() => {
    switch (code) {
      case "refusal":
        return "The AI declined to grade part of this scan.";
      case "max_tokens":
        return "The AI's answer for these pages was too long.";
      case "budget_reached":
        return "The AI reached its spending cap.";
      case "request_too_large":
        return "Part of this scan is too large for the AI.";
      case "invalid_output":
        return "The AI returned an unusable answer several times.";
      default:
        return `The AI service failed (${code}).`;
    }
  })();
  return graded
    ? `${what} The papers graded so far stay; try again to grade the rest.`
    : `${what} Try again, or have the AI split the scan first.`;
}

function noteScan(run: Run, note: string): boolean {
  return updateSplittingScan(run.scanId, run.generation, { statusNote: note });
}

/** `message` is for the teacher; `lastError` for jobs.last_error. A superseded run fails nothing. */
function failScan(run: Run, message: string, lastError: string = message): HandlerResult {
  const failed = updateSplittingScan(run.scanId, run.generation, { status: "failed", errorMessage: message, statusNote: null });
  return failed ? { kind: "fail", error: lastError } : DONE;
}

function pageRange(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}
