import { type AutoMark, autoMark } from "@/lib/grading/auto-mark";
import { type SpotItem, spotReadings, withSpotReadings } from "@/lib/omr/merge";
import type { SpotEvidence } from "@/lib/omr/types";
import type { AiUsage, Confidence } from "@/lib/types";
import { type AgentCallCost, AiError, classifySdkError } from "./errors";
import {
  type AiCallMeta, blindItems, type CallOptions, type DetectedSpot, type GradeInput, type Grader, type JudgeInput, type PacketChunkInput,
  type SpotDetection, writesNotes,
} from "./grader";
import { itemRefs } from "./prompts";
import type {
  CropTranscriptions, GradingOutput, JudgingOutput, PacketOutput, PacketReadingOutput, ReadingItem, ReadingOutput,
} from "./schemas";

// "Read blind, then mark": how every engine grades a paper (and each paper of a scan read in one pass).
// 1. READ: the engine transcribes the paper without the answer key (readSubmission / readPacketChunk). The request is built
//    from blindItems() only, so it cannot carry an expected answer, an accepted answer, criteria, notes, rulings or the key PDF.
// 2. MARK: code compares each transcription with the key where the answer is objective (autoMark).
// 3. JUDGE: the engine judges the remaining items from the transcriptions alone, text only (judgeSubmission). Skipped when
//    the program marked every item and the assignment's notes are off; with notes on it always runs (for the notes).
// The result is the same GradingOutput as before, plus who decided each item (judged_by) and what the reader saw (marks_seen).
//
// With a blank worksheet's answer spots (input.answerSpots, src/lib/omr), the marks are read before any AI call: each paper
// page is lined up with the blank and the ink the student added in each spot is measured. A choice is then read from its
// marks and a blank spot is blank, without the AI; a written spot is cropped and only the crop is transcribed
// (transcribeCrops: no question, no answers). Those readings replace the AI's for their items. When every item is read
// from its spots, the AI reads page 1 only, for the name, section and document check. A paper that can't be lined up is
// read entirely by the AI, as without spots, and flagged.

/** The calls an engine provides; the orchestration below is the same for every engine. */
export type BlindGrader = Pick<Grader, "readSubmission" | "judgeSubmission" | "transcribeCrops">;

/** Papers of one scan chunk judged at once (each judge call is a small text-only request). */
export const PACKET_JUDGE_PARALLEL = 4;

type PlannedItem = JudgeInput["reading"][number];
type GradingContext = Omit<GradeInput, "studentPdf" | "studentPageCount">;

/** READ, MARK and JUDGE one paper. A judge failure carries the read call's cost (billed), so the job layer records it. */
export async function gradeByReading(
  g: BlindGrader, input: GradeInput, o: CallOptions = {},
): Promise<{ output: GradingOutput; refs: string[]; meta: AiCallMeta }> {
  const refs = itemRefs(input.items.length);
  const pages = Array.from({ length: input.studentPageCount }, (_, i) => i + 1);
  const detection = input.answerSpots ? await input.answerSpots.read(input.studentPdf, pages, { signal: o.signal }) : null;
  const detected = detection?.ok ? detection.items : [];
  // Every item read from its spots (a written one only when this engine can transcribe its crop): page 1 is enough.
  const identityOnly = detection?.ok === true && refs.length > 0 && refs.every((ref) => coversRef(g, detected, ref));
  const read = await g.readSubmission({
    assignmentTitle: input.assignment.title,
    sections: input.sections,
    items: identityOnly ? [] : blindItems(input.items),
    studentPdf: identityOnly && detection?.ok ? detection.identityPdf : input.studentPdf,
    studentPageCount: identityOnly ? 1 : input.studentPageCount,
  }, o);
  let meta = read.meta;
  let judged: Awaited<ReturnType<typeof markAndJudge>>;
  let reading: ReadingOutput;
  let spotItems: Map<string, SpotItem>;
  try {
    const spots = await readFromSpots(g, input, refs, detection, { signal: o.signal });
    if (spots.meta) meta = combineMeta(meta, spots.meta);
    spotItems = spots.items;
    const own = identityOnly ? { ...read.output, document_check: { ...read.output.document_check, pages_appear_missing: false } } : read.output;
    reading = withSpotReadings(own, spotItems, refs);
    judged = await markAndJudge(g, input, refs, reading, o, spotItems);
  } catch (e) {
    throw withEarlierCost(e, meta);
  }
  const steps = { readMs: meta.durationMs, judgeMs: judged.meta?.durationMs ?? null };
  const output = { ...judged.output, ...spotsStatus(detection) };
  return { output, refs, meta: { ...(judged.meta === null ? meta : combineMeta(meta, judged.meta)), steps } };
}

/** An item mark detection reads entirely: a choice, a blank spot, or a written spot this engine can transcribe. */
function coversRef(g: BlindGrader, detected: DetectedSpot[], ref: string): boolean {
  const d = detected.find((x) => x.ref === ref);
  if (!d) return false;
  if (d.kind === "choice") return d.choice !== undefined;
  return d.written !== undefined && (!d.written.written || (d.crop !== undefined && g.transcribeCrops !== undefined));
}

/** The paper's mark-detection outcome, for reconcile (a paper that couldn't be lined up is flagged). */
function spotsStatus(detection: SpotDetection | null): Pick<GradingOutput, "answer_spots"> {
  if (detection === null) return {};
  return { answer_spots: detection.ok ? { status: "used", note: "" } : { status: "unaligned", note: detection.note } };
}

/** The spot readings of one paper: its written spots' crops transcribed (one call), then everything as readings. */
async function readFromSpots(
  g: BlindGrader, input: Pick<GradeInput, "items" | "guidance" | "teacherNotes">, refs: string[], detection: SpotDetection | null,
  o: CallOptions,
): Promise<{ items: Map<string, SpotItem>; meta: AiCallMeta | null }> {
  if (!detection?.ok) return { items: new Map(), meta: null };
  const crops = detection.items.flatMap((d) => (d.crop ? [{ id: d.ref, kind: d.kind, ...d.crop }] : []));
  let transcriptions: CropTranscriptions | null = null;
  let meta: AiCallMeta | null = null;
  if (crops.length > 0 && g.transcribeCrops) {
    const result = await g.transcribeCrops({ crops }, o);
    transcriptions = result.output;
    meta = result.meta;
  }
  const ruledItemIds = new Set((input.guidance?.lessons ?? []).map((l) => l.itemId));
  return { items: spotReadings(detection.items, input.items, refs, transcriptions, { ruledItemIds, teacherNotes: input.teacherNotes }), meta };
}

/**
 * One chunk of a scan in one pass: READ the chunk (its papers and their transcriptions, no answer key), then MARK and JUDGE
 * each paper on its own, PACKET_JUDGE_PARALLEL at a time. Pages stay chunk pages, as interpretChunk expects.
 */
export async function gradePacketByReading(
  g: BlindGrader & Pick<Grader, "readPacketChunk">, input: PacketChunkInput, o: CallOptions = {},
): Promise<{ output: PacketOutput; refs: string[]; meta: AiCallMeta }> {
  if (!g.readPacketChunk) throw new Error("This grader can't read a scan in one pass.");
  const refs = itemRefs(input.items.length);
  const read = await g.readPacketChunk({
    assignmentTitle: input.assignment.title,
    sections: input.sections,
    items: blindItems(input.items),
    chunkPdf: input.chunkPdf,
    firstPage: input.firstPage,
    chunkPageCount: input.chunkPageCount,
    totalPages: input.totalPages,
    keyPageCount: input.keyPageCount,
  }, o);

  const papers = read.output.papers;
  // Each paper's share of the chunk's reading time, for the time breakdown on its review page.
  const readShareMs = papers.length === 0 ? 0 : Math.round(read.meta.durationMs / papers.length);
  const graded = new Array<PacketOutput["papers"][number]>(papers.length);
  const metas: AiCallMeta[] = [];
  let failure: { error: unknown } | null = null;
  let next = 0;
  const worker = async () => {
    while (failure === null && next < papers.length) {
      const index = next++;
      const paper = papers[index];
      try {
        // Mark detection on this paper's pages of the chunk, when the assignment has answer spots.
        const pages = Array.from({ length: Math.max(0, paper.last_page - paper.first_page + 1) }, (_, i) => paper.first_page + i);
        const detection = input.answerSpots ? await input.answerSpots.read(input.chunkPdf, pages, { signal: o.signal }) : null;
        const spots = await readFromSpots(g, input, refs, detection, { signal: o.signal });
        if (spots.meta) metas.push(spots.meta);
        const reading = withSpotReadings(paper, spots.items, refs);
        // The chunk's max_tokens is sized for its reading; each judge call uses the engine's default.
        const judged = await markAndJudge(g, input, refs, reading, { signal: o.signal }, spots.items);
        if (judged.meta) metas.push(judged.meta);
        graded[index] = {
          ...boundary(paper), ...judged.output, ...spotsStatus(detection),
          timing: { readMs: readShareMs + (spots.meta?.durationMs ?? 0), judgeMs: judged.meta?.durationMs ?? null },
        };
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PACKET_JUDGE_PARALLEL, papers.length) }, worker));
  const meta = metas.reduce(combineMeta, read.meta);
  if (failure !== null) throw withEarlierCost((failure as { error: unknown }).error, meta);
  return { output: { papers: graded, skipped_pages: read.output.skipped_pages }, refs, meta };
}

function boundary(p: PacketReadingOutput["papers"][number]) {
  return {
    first_page: p.first_page,
    last_page: p.last_page,
    continues_from_previous_chunk: p.continues_from_previous_chunk,
    may_continue_after_chunk: p.may_continue_after_chunk,
    boundary_confidence: p.boundary_confidence,
  };
}

/** MARK the reading, JUDGE what is left (or skip the call), and combine. `meta` is the judge call's, null when skipped. */
async function markAndJudge(
  g: BlindGrader, input: GradingContext, refs: string[], reading: ReadingOutput, o: CallOptions,
  spots: Map<string, SpotItem> = new Map(),
): Promise<{ output: GradingOutput; meta: AiCallMeta | null }> {
  const plan = planMarks(input, refs, reading, spots);
  const writeNotes = writesNotes(input);
  if (!needsJudge(plan, writeNotes)) return { output: combineGrading(reading, plan, null, writeNotes), meta: null };
  const judged = await g.judgeSubmission({
    assignment: input.assignment,
    teacherNotes: input.teacherNotes,
    sections: input.sections,
    items: input.items,
    guidance: input.guidance,
    writeNotes,
    reading: plan,
    unmatchedWork: reading.unmatched_work,
  }, o);
  return { output: combineGrading(reading, plan, judged.output, writeNotes), meta: judged.meta };
}

/** The judge is called when an item is left to it, or (notes on) to write the notes; never for a paper with nothing read. */
export function needsJudge(plan: PlannedItem[], writeNotes: boolean): boolean {
  if (plan.length === 0) return false;
  return writeNotes || plan.some((p) => p.mark === null);
}

/**
 * Each read item in key order with the program's mark (null: for the judge). An item the reader left out is left out here
 * too (reconcile reports it); an item the teacher has a ruling on is always left to the judge, which applies rulings.
 */
export function planMarks(
  input: Pick<GradeInput, "items" | "guidance" | "teacherNotes">, refs: string[], reading: ReadingOutput,
  spots: Map<string, SpotItem> = new Map(),
): Array<PlannedItem & { spot?: SpotEvidence }> {
  const byRef = new Map<string, ReadingItem>();
  for (const item of reading.items) {
    const ref = normalizeRef(item.ref);
    if (!byRef.has(ref)) byRef.set(ref, item);
  }
  const ruled = new Set((input.guidance?.lessons ?? []).map((l) => l.itemId));
  return refs.flatMap((ref, index) => {
    const read = byRef.get(ref);
    const keyItem = input.items[index];
    if (!read || !keyItem) return [];
    // Read from its answer spot: the marks' own mark when they decide it (a choice, a blank), else compared as usual.
    const spot = spots.get(ref);
    const mark: AutoMark | null = spot && spot.mark !== undefined
      ? spot.mark
      : autoMark(keyItem, read, { hasRuling: ruled.has(keyItem.id), teacherNotes: input.teacherNotes });
    return [{ ref, item: { ...read, ref }, mark, ...(spot ? { spot: spot.spot } : {}) }];
  });
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * The paper's grading from its reading, the program's marks and the judge's answer: the transcription, pages, legibility,
 * identity and document check always come from the reading; correctness from the program or the judge (judged_by); the
 * notes from the judge when they are on. A judged item's confidence is never above the reader's, and a low-confidence
 * reading is always sent to the teacher (ambiguous_reading when the judge gave no other reason). An item the judge left out
 * is left out (reconcile reports it).
 */
export function combineGrading(
  reading: ReadingOutput, plan: Array<PlannedItem & { spot?: SpotEvidence }>, judged: JudgingOutput | null, writeNotes: boolean,
): GradingOutput {
  const judgedByRef = new Map<string, JudgingOutput["items"][number]>();
  for (const j of judged?.items ?? []) {
    const ref = normalizeRef(j.ref);
    if (!judgedByRef.has(ref)) judgedByRef.set(ref, j);
  }
  const items = plan.flatMap(({ ref, item: r, mark, spot }): GradingOutput["items"] => {
    const j = judgedByRef.get(ref);
    const notes = writeNotes && j
      ? { what_student_did: j.what_student_did, feedback: j.feedback, teacher_note: j.teacher_note }
      : { what_student_did: "", feedback: "", teacher_note: "" };
    const read = {
      ref, pages: r.pages, student_answer: r.student_answer, legibility: r.legibility, marks_seen: r.marks_seen, ...(spot ? { spot } : {}),
    };
    if (mark) {
      return [{
        ...read, attempt: r.attempt, correctness: mark.correctness, confidence: mark.confidence, review_reason: mark.review_reason,
        ...notes, judged_by: "program",
      }];
    }
    if (!j) return [];
    const confidence = CONFIDENCE_RANK[j.confidence] <= CONFIDENCE_RANK[r.reading_confidence] ? j.confidence : r.reading_confidence;
    const reviewReason = r.reading_confidence === "low" && j.review_reason === "none" ? "ambiguous_reading" : j.review_reason;
    return [{
      ...read, attempt: j.attempt, correctness: j.correctness, confidence, review_reason: reviewReason, ...notes, judged_by: "ai",
    }];
  });
  return {
    student: reading.student,
    document_check: reading.document_check,
    items,
    integrity: reading.integrity,
    unmatched_work: reading.unmatched_work,
    overall_feedback: writeNotes ? (judged?.overall_feedback ?? "") : "",
    teacher_summary: writeNotes ? (judged?.teacher_summary ?? "") : "",
  };
}

function normalizeRef(ref: string): string {
  return ref.replace(/[[\]]/g, "").trim().toUpperCase();
}

/** Two calls as one: the first call's models, the usage, time and agent cost of both. */
export function combineMeta(a: AiCallMeta, b: AiCallMeta): AiCallMeta {
  const agent = sumAgent(a.agent, b.agent);
  return {
    requestedModel: a.requestedModel,
    servedModel: a.servedModel,
    fallbackUsed: a.fallbackUsed || b.fallbackUsed,
    stopReason: b.stopReason,
    usage: addUsage(a.usage, b.usage),
    durationMs: a.durationMs + b.durationMs,
    ...(agent ? { agent } : {}),
  };
}

/** An error from a later call, carrying the cost of the calls that succeeded before it (the job layer records billed usage). */
export function withEarlierCost(e: unknown, earlier: AiCallMeta): AiError {
  const err = classifySdkError(e);
  const billed = err.o.billed ?? null;
  const agent = sumAgent(earlier.agent, billed?.agent ?? undefined);
  return new AiError(err.code, err.message, {
    ...err.o,
    billed: {
      servedModel: billed?.servedModel ?? earlier.servedModel,
      usage: billed ? addUsage(earlier.usage, billed.usage) : earlier.usage,
      ...(agent ? { agent } : {}),
    },
  });
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function sumAgent(a: AgentCallCost | null | undefined, b: AgentCallCost | null | undefined): AgentCallCost | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return {
    listCostCents: a.listCostCents === null || b.listCostCents === null ? (a.listCostCents ?? b.listCostCents) : a.listCostCents + b.listCostCents,
    activeSeconds: a.activeSeconds + b.activeSeconds,
  };
}
