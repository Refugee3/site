import { AiError, classifySdkError } from "@/lib/ai/errors";
import { type AiCallMeta, blindItems, type DetectedSpot, type Grader } from "@/lib/ai/grader";
import { itemRefs } from "@/lib/ai/prompts";
import {
  type GradingContext, IDENTITY_CROP_IDS, identityReading, markAndJudge, PACKET_JUDGE_PARALLEL,
} from "@/lib/ai/read-then-mark";
import type { CropTranscriptions, GradingOutput, ReadingItem, ReadingOutput } from "@/lib/ai/schemas";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { getAssignment, listSections } from "@/lib/db/repos/assignments";
import { updateSplittingScan } from "@/lib/db/repos/scans";
import { countSubmissions, findBySha, insertSubmission, saveGradingResult } from "@/lib/db/repos/submissions";
import { AppError, isAppError } from "@/lib/errors";
import { FLAG_CODES } from "@/lib/types";
import { statusFromFlags } from "@/lib/flags";
import { splitUsage } from "@/lib/grading/packet";
import { reconcileGrading } from "@/lib/grading/reconcile";
import { newId, newToken, sha256Hex } from "@/lib/ids";
import { decideFailure } from "@/lib/jobs/backoff";
import { addUsage, describe, DONE, failureLimits, type HandlerResult, isFinalRefusal, readStoredPdf, recordUsage } from "@/lib/jobs/handler-shared";
import { enqueueGrade, PRIORITY } from "@/lib/jobs/queue";
import { prepareWorksheet } from "@/lib/omr/detect";
import { type Crop, DEFAULT_CROPS_PER_CALL, transcribeInBatches } from "@/lib/omr/fast-lane/batch";
import { type GroupedPaper, groupPages } from "@/lib/omr/fast-lane/group";
import { type AnalyzedPage, analyzeScan } from "@/lib/omr/fast-lane/scan";
import { spotReadings, withSpotReadings } from "@/lib/omr/merge";
import { formatPageRanges } from "@/lib/scan-layout";
import type { AssignmentGuidance } from "@/lib/services/guidance";
import { getRoster } from "@/lib/services/rosters";
import { rescoreSubmission } from "@/lib/services/submissions";
import type { FastLaneSpots } from "@/lib/services/worksheets";
import { removeDataFile, writeFileAtomic } from "@/lib/storage/files";
import { submissionPdfRel } from "@/lib/storage/paths";
import { CutTooLargeError, extractPageSets } from "@/lib/storage/pdf";
import type {
  AiUsage, AnswerKey, Assignment, FastLaneProgress, Job, KeyItem, OnePassPaper, OnePassProgress, Scan, Section, SkippedPage,
} from "@/lib/types";

// The fast lane: a whole-class scan of an assignment whose blank worksheet has saved answer spots is graded without the AI
// ever reading a full page (src/lib/omr/fast-lane):
// 1. MATCH: every scan page is rendered once and matched to a page of the blank worksheet; pages that line up are read at
//    once (choices and blanks from their ink, crops of what is written, the name spots' ink and crops). No AI.
// 2. SPLIT: a paper starts at each page that matches blank page 1 (group.ts); blank backs and covers are left out, anything
//    unusual flags the paper "Check the paper's pages".
// 3. READ: every crop of every paper (names, classes, written answers) is transcribed in batches across students
//    (transcribeCrops, up to the engine's crops per call, as many calls at once as the engine allows); the class list is sent
//    only with name crops.
// 4. MARK: each paper is marked in code and judged (text only) where needed, exactly as one paper on its own
//    (markAndJudge), then cut from the scan and stored graded like a paper graded in one pass. A paper with an item no spot
//    could read (a page that didn't line up well, a crop the AI left out) is read by the AI from its own pages first.
// When fewer than half of the scan's pages with ink match the blank worksheet, the scan is graded by the AI reading every
// page instead (one pass), as without a blank.
//
// Crash safety: each paper is stored in one transaction with the scan's progress (its pages), so a run that stops resumes
// with the papers not stored yet; matching and reading are repeated for those (matching is free, the AI reads only the
// remaining papers' crops).

export const FAST_LANE_FALLBACK_NOTE = "Fewer than half of the scan's pages matched the blank worksheet, so the AI reads every page instead.";
/** Below this share of the pages with ink matching the blank, the AI reads the scan (one pass) instead. */
export const FAST_LANE_MIN_MATCHED = 0.5;

export interface FastLaneRun {
  job: Job;
  grader: Grader;
  signal: AbortSignal;
  scan: Scan;
  assignment: Assignment;
  key: AnswerKey;
  items: KeyItem[];
  sections: Section[];
  guidance: AssignmentGuidance;
  spots: FastLaneSpots;
  progress: OnePassProgress;
}

export type FastLaneOutcome = HandlerResult | { kind: "fallback"; note: string };

class Superseded extends Error {}

interface MarkedPaper {
  paper: GroupedPaper;
  index: number;
  output: GradingOutput;
  meta: { servedModel: string; fallbackUsed: boolean; usage: AiUsage };
  readMs: number;
  judgeMs: number | null;
}

/** The fast lane for one scan, or "fallback" when its pages don't match the blank worksheet well enough. */
export async function runFastLane(r: FastLaneRun): Promise<FastLaneOutcome> {
  const { scan, grader, spots } = r;
  const generation = scan.splitGeneration;
  const cfg = getConfig();
  let progress: OnePassProgress = r.progress;
  let usage = scan.usage;
  /** Saves the stage's progress, at most every 400 ms (and always at a stage's end). */
  let lastWrite = 0;
  const report = (stage: Omit<FastLaneProgress, "startedAt">, force = false): void => {
    const startedAt = progress.fastLane?.stage === stage.stage ? (progress.fastLane.startedAt ?? now()) : now();
    const fastLane: FastLaneProgress = { ...stage, startedAt };
    progress = { ...progress, fastLane };
    const at = Date.now();
    if (!force && at - lastWrite < 400 && fastLane.done < fastLane.total) return;
    lastWrite = at;
    if (!updateSplittingScan(scan.id, generation, { onePass: progress, statusNote: null })) throw new Superseded();
  };

  try {
    const scanPdf = await readStoredPdf(scan.pdfPath);
    if (!scanPdf) return failScan(r, "The uploaded scan is missing on the server. Upload it again.");
    const worksheet = await prepareWorksheet(await spots.blankPdf(), spots.sha);
    const identity = await spots.identity();
    report({ stage: "matching", done: 0, total: scan.pageCount }, true);
    const matchStarted = performance.now();
    const pages = await analyzeScan({
      scanPdf, worksheet, plan: spots.plan, identity, signal: r.signal,
      onPage: (done, total) => report({ stage: "matching", done, total }, done === total),
    });
    const matchMs = performance.now() - matchStarted;
    console.info(`[fast-lane] scan ${scan.id}: matched ${pages.length} pages in ${Math.round(matchMs)} ms `
      + `(${Math.round(matchMs / Math.max(1, pages.length))} ms a page, ${pages.reduce((n, p) => n + p.tried, 0)} page fits)`);

    const grouping = groupPages(pages, worksheet.pages.length);
    if (grouping.papers.length === 0 || grouping.matchedShare < FAST_LANE_MIN_MATCHED) {
      return { kind: "fallback", note: FAST_LANE_FALLBACK_NOTE };
    }
    const stored = new Set(progress.papers.map((p) => (p.pages ?? []).join(",")));
    const todo = grouping.papers
      .map((paper, index) => ({ paper, index }))
      .filter(({ paper }) => !stored.has(paper.pages.map((p) => p.scanPage).join(",")));
    const byPage = new Map(pages.map((p) => [p.page, p]));

    // READ: every crop of the papers left, across students, in batches.
    const crops = todo.flatMap(({ paper, index }) => paperCrops(paper, index, byPage));
    report({ stage: "reading", done: 0, total: crops.length }, true);
    const transcribed = await transcribeInBatches(grader, crops, {
      size: cropsPerCall(grader),
      // A local model reads all of a call's images in its context: about 5 000 image tokens a call at most.
      maxPixels: grader.engine === "ollama" ? OLLAMA_PIXELS_PER_CALL : undefined,
      concurrency: Math.max(1, grader.parallel ?? cfg.scanSplitParallel),
      nameHints: getRoster(r.assignment.id).map((e) => e.name),
      signal: r.signal,
      onBatch: (done, total) => report({ stage: "reading", done, total }, done === total),
      onCall: (meta) => {
        recordUsage(r.assignment.id, meta.servedModel, meta.usage, meta.agent);
        usage = addUsage(usage, meta.usage);
      },
    });
    if (transcribed.meta && !updateSplittingScan(scan.id, generation, { usage, aiModel: transcribed.meta.servedModel })) throw new Superseded();
    const cropShares = splitUsage(transcribed.meta?.usage ?? NO_USAGE, Math.max(1, crops.length));

    // MARK and store each paper.
    const cut = await cutPapers(scanPdf, todo.map(({ paper }) => paper), cfg.maxUploadBytes);
    if ("error" in cut) return failScan(r, cut.error);
    report({ stage: "marking", done: 0, total: todo.length }, true);
    const ctx: GradingContext = {
      assignment: r.assignment, teacherNotes: r.key.teacherNotes, sections: r.sections, items: r.items,
      guidance: r.guidance.guidance, writeNotes: r.assignment.writeNotes,
    };
    let marked = 0;
    let storing: Promise<unknown> = Promise.resolve();
    let failure: { error: unknown } | null = null;
    let next = 0;
    let cropIndex = 0;
    const cropOffsets = todo.map(({ paper, index }) => {
      const n = paperCrops(paper, index, byPage).length;
      const at = cropIndex;
      cropIndex += n;
      return { at, n };
    });
    const worker = async () => {
      while (failure === null && next < todo.length) {
        const t = next++;
        const { paper, index } = todo[t];
        try {
          const share = cropOffsets[t];
          const paperUsage = cropShares.slice(share.at, share.at + share.n).reduce(addUsageTotal, NO_USAGE);
          const result = await markPaper({
            r, ctx, paper, index, byPage, texts: transcribed.texts, pdf: cut.pdfs[t],
            transcribeMs: crops.length === 0 ? 0 : Math.round((transcribed.wallMs * share.n) / crops.length),
            usage: paperUsage, servedModel: transcribed.meta?.servedModel ?? null, fallbackUsed: transcribed.meta?.fallbackUsed ?? false,
            onCall: (meta) => {
              recordUsage(r.assignment.id, meta.servedModel, meta.usage, meta.agent);
              usage = addUsage(usage, meta.usage);
            },
          });
          // One paper stored at a time, in the order they finish.
          const store = storing.then(async () => {
            progress = await storePaper(r, progress, result, cut.pdfs[t], usage);
            marked++;
            report({ stage: "marking", done: marked, total: todo.length }, true);
          });
          storing = store.catch(() => undefined);
          await store;
        } catch (error) {
          failure ??= { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, grader.parallel ?? PACKET_JUDGE_PARALLEL), Math.max(1, todo.length)) }, worker));
    if (failure !== null) throw (failure as { error: unknown }).error;

    const skipped: SkippedPage[] = grouping.skipped.map((s) => ({ page: s.page, reason: s.reason }));
    const done: OnePassProgress = {
      ...progress, nextPage: scan.pageCount + 1, endedCleanly: true, chunks: Math.max(1, progress.chunks), skipped, pending: null,
      fastLane: { stage: "done", done: grouping.papers.length, total: grouping.papers.length },
    };
    updateSplittingScan(scan.id, generation, {
      onePass: done, status: "done", statusNote: null, errorMessage: null, pagesRead: scan.pageCount, splitFinishedAt: now(), usage,
    });
    return DONE;
  } catch (e) {
    if (e instanceof Superseded) return DONE;
    if (e instanceof StoreFailure) return failScan(r, e.message);
    if (!(e instanceof AiError) && !isAiShaped(e)) throw e;
    return fastLaneFailure(r, classifySdkError(e), progress.papers.length > r.progress.papers.length);
  }
}

/** Ollama: crop pixels per call (Qwen2.5-VL reads 28×28-pixel patches: ~5 000 tokens of a 16 384-token context). */
const OLLAMA_PIXELS_PER_CALL = 4_000_000;

const NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function addUsageTotal(a: AiUsage, b: AiUsage): AiUsage {
  return addUsage(a, b);
}

/** Crops per transcribeCrops call: the engine's (Ollama), CROPS_PER_CALL for Claude, DEFAULT_CROPS_PER_CALL otherwise. */
export function cropsPerCall(g: Pick<Grader, "cropsPerCall" | "engine">): number {
  if (g.cropsPerCall !== undefined) return g.cropsPerCall;
  return g.engine === "direct" || g.engine === "agent" ? getConfig().cropsPerCall : DEFAULT_CROPS_PER_CALL;
}

/** A crop's id in the scan: the paper's number and the item's ref ("P3-Q2", "P3-NAME"). */
function cropId(index: number, ref: string): string {
  return `P${index + 1}-${ref}`;
}

/** The crops of one paper: what is written in its name and class spots, and in its written answer spots. */
function paperCrops(paper: GroupedPaper, index: number, byPage: Map<number, AnalyzedPage>): Crop[] {
  const out: Crop[] = [];
  const identity = new Set<string>();
  for (const { scanPage } of paper.pages) {
    const page = byPage.get(scanPage);
    if (!page?.spots) continue;
    for (const c of page.spots.identity) {
      if (!c.written || !c.crop || identity.has(c.kind)) continue;
      identity.add(c.kind);
      out.push({ id: cropId(index, IDENTITY_CROP_IDS[c.kind]), kind: c.kind, ...c.crop });
    }
    for (const { detected } of page.spots.items) {
      if (detected.crop) out.push({ id: cropId(index, detected.ref), kind: detected.kind, ...detected.crop });
    }
  }
  return out;
}

const MISSING_PAGE = "this page of the worksheet wasn't found in the scan";

/** READ (from the spots and crops; the AI only for what they couldn't read), MARK and JUDGE one paper. */
async function markPaper(i: {
  r: FastLaneRun; ctx: GradingContext; paper: GroupedPaper; index: number; byPage: Map<number, AnalyzedPage>;
  texts: Map<string, CropTranscriptions["crops"][number]>; pdf: Uint8Array; transcribeMs: number; usage: AiUsage;
  servedModel: string | null; fallbackUsed: boolean; onCall: (meta: AiCallMeta) => void;
}): Promise<MarkedPaper> {
  const { r, paper, index } = i;
  const refs = itemRefs(r.items.length);
  // The paper's own page numbers: its pages in worksheet order (a missing page shifts the later ones).
  const paperPage = new Map(paper.pages.map((p, n) => [p.blankPage, n + 1]));
  const detected: Array<{ planIndex: number; detected: DetectedSpot }> = [];
  let pageMs = 0;
  let unreadablePage = false;
  for (const { scanPage, blankPage } of paper.pages) {
    const page = i.byPage.get(scanPage);
    pageMs += (page?.matchMs ?? 0) + (page?.readMs ?? 0);
    if (!page?.spots) {
      unreadablePage = true;
      continue;
    }
    for (const d of page.spots.items) {
      const at = paperPage.get(blankPage)!;
      detected.push({ ...d, detected: { ...d.detected, evidence: { ...d.detected.evidence, page: at } } });
    }
  }
  detected.sort((a, b) => a.planIndex - b.planIndex);
  const prefix = cropId(index, "");
  const crops: CropTranscriptions = {
    crops: [...i.texts.entries()].filter(([id]) => id.startsWith(prefix)).map(([id, t]) => ({ ...t, id: id.slice(prefix.length) })),
  };
  const ruledItemIds = new Set((r.guidance.guidance.lessons ?? []).map((l) => l.itemId));
  const spotItems = spotReadings(detected.map((d) => d.detected), r.items, refs, crops, { ruledItemIds, teacherNotes: r.key.teacherNotes });
  // Items on a worksheet page the scan doesn't have: no answer, for the teacher to check (the paper is flagged).
  const missing = r.spots.plan.filter(({ ref, spot }) => !spotItems.has(ref) && paper.missing.includes(spot.page)).map(({ ref }) => missingItem(ref));

  let meta: { servedModel: string; fallbackUsed: boolean; usage: AiUsage } = {
    servedModel: i.servedModel ?? "none", fallbackUsed: i.fallbackUsed, usage: i.usage,
  };
  let readMs = pageMs + i.transcribeMs;
  const uncovered = refs.some((ref) => !spotItems.has(ref) && !missing.some((m) => m.ref === ref));
  let base: ReadingOutput = identityReading(crops, {
    name: crops.crops.some((c) => c.id === IDENTITY_CROP_IDS.name) ? IDENTITY_CROP_IDS.name : null,
    section: crops.crops.some((c) => c.id === IDENTITY_CROP_IDS.section) ? IDENTITY_CROP_IDS.section : null,
  });
  if (uncovered || unreadablePage) {
    // Something no spot could read: the AI reads this paper's own pages (not the whole scan), as a paper on its own.
    const read = await r.grader.readSubmission({
      assignmentTitle: r.assignment.title, sections: r.sections, items: blindItems(r.items), studentPdf: i.pdf,
      studentPageCount: paper.pages.length,
    }, { signal: r.signal });
    i.onCall(read.meta);
    readMs += read.meta.durationMs;
    meta = { servedModel: read.meta.servedModel, fallbackUsed: meta.fallbackUsed || read.meta.fallbackUsed, usage: addUsageTotal(meta.usage, read.meta.usage) };
    // The name from its crop when one was read, else the AI's reading of the page.
    base = { ...read.output, student: base.student.name !== null ? base.student : read.output.student };
  }
  // Items on a worksheet page the scan doesn't have: read as unanswered, for the teacher to check (the paper is flagged).
  const reading = withSpotReadings({ ...base, items: [...base.items.filter((it) => !missing.some((m) => m.ref === it.ref)), ...missing] }, spotItems, refs);
  const withMissing: ReadingOutput = paper.missing.length > 0
    ? { ...reading, document_check: { ...reading.document_check, pages_appear_missing: true } }
    : reading;
  const judged = await markAndJudge(r.grader, i.ctx, refs, withMissing, { signal: r.signal }, spotItems);
  if (judged.meta) {
    i.onCall(judged.meta);
    meta = { ...meta, usage: addUsageTotal(meta.usage, judged.meta.usage), fallbackUsed: meta.fallbackUsed || judged.meta.fallbackUsed };
    if (meta.servedModel === "none") meta.servedModel = judged.meta.servedModel;
  }
  return {
    paper, index, meta, readMs: Math.round(readMs), judgeMs: judged.meta?.durationMs ?? null,
    output: { ...judged.output, answer_spots: { status: "used", note: "" } },
  };
}

function missingItem(ref: string): ReadingItem {
  return { ref, pages: [], student_answer: "", marks_seen: MISSING_PAGE, legibility: "no_writing", attempt: "none", reading_confidence: "low" };
}

/** Errors from an AI call that classifySdkError turns into AiError (aborts, timeouts, SDK errors). */
function isAiShaped(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError" || "status" in e);
}

class StoreFailure extends Error {}

/** Each paper's PDF, its pages in worksheet order. */
async function cutPapers(scanPdf: Uint8Array, papers: GroupedPaper[], maxBytes: number): Promise<{ pdfs: Uint8Array[] } | { error: string }> {
  if (papers.length === 0) return { pdfs: [] };
  try {
    return { pdfs: await extractPageSets(scanPdf, papers.map((p) => p.pages.map((x) => x.scanPage)), { maxBytesPerSet: maxBytes }) };
  } catch (e) {
    if (e instanceof CutTooLargeError) {
      const pages = papers[e.index].pages.map((x) => x.scanPage);
      return { error: `The paper on pages ${formatPageRanges(pages)} is too large to store. Rescan at a lower resolution.` };
    }
    if (isAppError(e) && e.code === "invalid_pdf") return { error: "The scan could not be read. Upload it again." };
    throw e;
  }
}

/**
 * Stores one paper and records it in the scan's progress, in one transaction: as a teacher submission already graded, or,
 * when the same pages are already in the assignment, only as a duplicate.
 */
async function storePaper(r: FastLaneRun, progress: OnePassProgress, m: MarkedPaper, pdf: Uint8Array, scanUsage: AiUsage | null): Promise<OnePassProgress> {
  const { scan } = r;
  const pages = m.paper.pages.map((p) => p.scanPage);
  const sha = sha256Hex(pdf);
  const record = (submissionId: string | null): OnePassProgress => {
    const entry: OnePassPaper = {
      firstPage: Math.min(...pages), lastPage: Math.max(...pages), submissionId, flagged: m.paper.notes.length > 0, pages,
    };
    // In scan order, whichever paper was marked first.
    const papers = [...progress.papers, entry].sort((x, y) => x.firstPage - y.firstPage);
    const created = papers.filter((p) => p.submissionId !== null).length;
    if (!updateSplittingScan(scan.id, scan.splitGeneration, {
      onePass: { ...progress, papers }, createdCount: created, duplicateCount: papers.length - created, usage: scanUsage,
    })) {
      throw new Superseded();
    }
    return { ...progress, papers };
  };
  if (findBySha(scan.assignmentId, sha) || r.key.sourceSha256 === sha) return tx(() => record(null));
  const id = newId();
  const pdfPath = submissionPdfRel(scan.assignmentId, id);
  await writeFileAtomic(pdfPath, pdf);
  try {
    return tx(() => {
      const next = record(id);
      const assignment = getAssignment(scan.assignmentId);
      if (!assignment) throw new Superseded();
      if (countSubmissions(scan.assignmentId) >= assignment.maxSubmissions) {
        throw new AppError("submission_limit", "This assignment has reached its submission limit. Raise it in the assignment's "
          + "Settings, then try again; the papers graded so far stay.");
      }
      const submission = insertSubmission({
        id, assignmentId: scan.assignmentId, source: "teacher", receiptToken: newToken(), pdfPath,
        originalFilename: `${scan.originalFilename} (pages ${formatPageRanges(pages)})`,
        contentSha256: sha, byteSize: pdf.byteLength, pageCount: pages.length,
      });
      saveGrading(r, submission, m);
      return next;
    });
  } catch (e) {
    await removeDataFile(pdfPath);
    if (isAppError(e) && e.code === "duplicate") return tx(() => record(null));
    if (isAppError(e) && e.code === "submission_limit") throw new StoreFailure(e.message);
    throw e;
  }
}

/** Runs inside the transaction that inserted `submission`: its grading, with the paper's notes on where it starts or ends. */
function saveGrading(r: FastLaneRun, submission: ReturnType<typeof insertSubmission>, m: MarkedPaper): void {
  let reconciled: ReturnType<typeof reconcileGrading>;
  try {
    reconciled = reconcileGrading({
      output: m.output, refs: itemRefs(r.items.length), items: r.items, sections: listSections(submission.assignmentId),
      pageCount: submission.pageCount, current: submission, fallbackUsed: m.meta.fallbackUsed, roster: getRoster(submission.assignmentId),
    });
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    // Most items missing for this paper: it is graded on its own instead.
    enqueueGrade(submission.id, submission.assignmentId, PRIORITY.teacher);
    return;
  }
  const flagged = m.paper.notes.length > 0;
  const flags = flagged ? FLAG_CODES.filter((code) => code === "paper_boundary" || reconciled.fields.flags.includes(code)) : reconciled.fields.flags;
  const teacherSummary = [reconciled.fields.teacherSummary, ...m.paper.notes].filter((line) => line !== "").join("\n");
  const saved = saveGradingResult({
    submissionId: submission.id,
    generation: submission.gradingGeneration,
    keyRevision: r.key.revision,
    guidanceFingerprint: r.guidance.fingerprint,
    spotRevision: r.spots.spotRevision,
    items: reconciled.items,
    fields: {
      ...reconciled.fields, flags, teacherSummary, status: statusFromFlags(flags, null),
      aiModel: m.meta.servedModel, usage: m.meta.usage, aiOutputJson: JSON.stringify(m.output), aiEngine: r.grader.engine,
      readMs: m.readMs, judgeMs: m.judgeMs, fastLane: true,
    },
  });
  if (saved) rescoreSubmission(submission.id);
}

/** A failed AI call: retried later (a run that stored papers doesn't use up an attempt), paused, or the scan fails. */
function fastLaneFailure(r: FastLaneRun, err: AiError, stored: boolean): HandlerResult {
  if (err.o.billed) recordUsage(r.assignment.id, err.o.billed.servedModel, err.o.billed.usage, err.o.billed.agent);
  const job = stored ? { ...r.job, attempts: r.job.attempts - 1 } : r.job;
  const graded = stored || r.progress.papers.length > 0;
  const rest = graded ? " The papers graded so far stay; try again to grade the rest." : " Try again.";
  if (isFinalRefusal(job, err)) return failScan(r, `The AI declined to read part of this scan.${rest}`, describe(err));
  const decision = decideFailure(job, err, failureLimits());
  switch (decision.action) {
    case "requeue":
      return updateSplittingScan(r.scan.id, r.scan.splitGeneration, { statusNote: decision.note })
        ? {
          kind: "requeue", runAfter: decision.runAfter, error: describe(err), maxTokens: decision.maxTokens,
          refundAttempt: decision.refundAttempt || stored, throttled: decision.throttled,
        }
        : DONE;
    case "pause":
      return updateSplittingScan(r.scan.id, r.scan.splitGeneration, { statusNote: `Paused: ${decision.reason}` })
        ? { kind: "pause", resumeAt: decision.resumeAt, reason: decision.reason, code: decision.code }
        : DONE;
    case "fail":
      return failScan(r, `${decision.message}${graded ? " The papers graded so far stay." : ""}`, describe(err));
  }
}

function failScan(r: FastLaneRun, message: string, lastError: string = message): HandlerResult {
  const failed = updateSplittingScan(r.scan.id, r.scan.splitGeneration, { status: "failed", errorMessage: message, statusNote: null });
  return failed ? { kind: "fail", error: lastError } : DONE;
}

