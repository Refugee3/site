import { type AutoMark, autoMark } from "@/lib/grading/auto-mark";
import type { AiUsage, Confidence } from "@/lib/types";
import { type AgentCallCost, AiError, classifySdkError } from "./errors";
import {
  type AiCallMeta, blindItems, type CallOptions, type GradeInput, type Grader, type JudgeInput, type PacketChunkInput, writesNotes,
} from "./grader";
import { itemRefs } from "./prompts";
import type { GradingOutput, JudgingOutput, PacketOutput, PacketReadingOutput, ReadingItem, ReadingOutput } from "./schemas";

// "Read blind, then mark": how every engine grades a paper (and each paper of a scan read in one pass).
// 1. READ: the engine transcribes the paper without the answer key (readSubmission / readPacketChunk). The request is built
//    from blindItems() only, so it cannot carry an expected answer, an accepted answer, criteria, notes, rulings or the key PDF.
// 2. MARK: code compares each transcription with the key where the answer is objective (autoMark).
// 3. JUDGE: the engine judges the remaining items from the transcriptions alone, text only (judgeSubmission). Skipped when
//    the program marked every item and the assignment's notes are off; with notes on it always runs (for the notes).
// The result is the same GradingOutput as before, plus who decided each item (judged_by) and what the reader saw (marks_seen).

/** The two calls an engine provides; the orchestration below is the same for every engine. */
export type BlindGrader = Pick<Grader, "readSubmission" | "judgeSubmission">;

/** Papers of one scan chunk judged at once (each judge call is a small text-only request). */
export const PACKET_JUDGE_PARALLEL = 4;

type PlannedItem = JudgeInput["reading"][number];
type GradingContext = Omit<GradeInput, "studentPdf" | "studentPageCount">;

/** READ, MARK and JUDGE one paper. A judge failure carries the read call's cost (billed), so the job layer records it. */
export async function gradeByReading(
  g: BlindGrader, input: GradeInput, o: CallOptions = {},
): Promise<{ output: GradingOutput; refs: string[]; meta: AiCallMeta }> {
  const refs = itemRefs(input.items.length);
  const read = await g.readSubmission({
    assignmentTitle: input.assignment.title,
    sections: input.sections,
    items: blindItems(input.items),
    studentPdf: input.studentPdf,
    studentPageCount: input.studentPageCount,
  }, o);
  let judged: Awaited<ReturnType<typeof markAndJudge>>;
  try {
    judged = await markAndJudge(g, input, refs, read.output, o);
  } catch (e) {
    throw withEarlierCost(e, read.meta);
  }
  return { output: judged.output, refs, meta: judged.meta === null ? read.meta : combineMeta(read.meta, judged.meta) };
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
  const graded = new Array<PacketOutput["papers"][number]>(papers.length);
  const metas: AiCallMeta[] = [];
  let failure: { error: unknown } | null = null;
  let next = 0;
  const worker = async () => {
    while (failure === null && next < papers.length) {
      const index = next++;
      const paper = papers[index];
      try {
        // The chunk's max_tokens is sized for its reading; each judge call uses the engine's default.
        const judged = await markAndJudge(g, input, refs, paper, { signal: o.signal });
        if (judged.meta) metas.push(judged.meta);
        graded[index] = { ...boundary(paper), ...judged.output };
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
): Promise<{ output: GradingOutput; meta: AiCallMeta | null }> {
  const plan = planMarks(input, refs, reading);
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
): PlannedItem[] {
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
    const mark: AutoMark | null = autoMark(keyItem, read, { hasRuling: ruled.has(keyItem.id), teacherNotes: input.teacherNotes });
    return [{ ref, item: { ...read, ref }, mark }];
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
  reading: ReadingOutput, plan: PlannedItem[], judged: JudgingOutput | null, writeNotes: boolean,
): GradingOutput {
  const judgedByRef = new Map<string, JudgingOutput["items"][number]>();
  for (const j of judged?.items ?? []) {
    const ref = normalizeRef(j.ref);
    if (!judgedByRef.has(ref)) judgedByRef.set(ref, j);
  }
  const items = plan.flatMap(({ ref, item: r, mark }): GradingOutput["items"] => {
    const j = judgedByRef.get(ref);
    const notes = writeNotes && j
      ? { what_student_did: j.what_student_did, feedback: j.feedback, teacher_note: j.teacher_note }
      : { what_student_did: "", feedback: "", teacher_note: "" };
    const read = { ref, pages: r.pages, student_answer: r.student_answer, legibility: r.legibility, marks_seen: r.marks_seen };
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
