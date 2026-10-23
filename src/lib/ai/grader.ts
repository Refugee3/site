import type { AutoMark } from "@/lib/grading/auto-mark";
import type { ChoiceReading, WriteInReading } from "@/lib/omr/decide";
import type { IdentityCrop, SpotEvidence, SpotKind } from "@/lib/omr/types";
import type { AiUsage, AnswerType, Assignment, GradingGuidance, KeyItem, ScanPageKind, Section } from "@/lib/types";
import type { AgentCallCost } from "./errors";
import type {
  CropTranscriptions, GradingOutput, JudgingOutput, KeyExtraction, PacketOutput, PacketReadingOutput, ReadingOutput, ScanPages,
  SpotProposal,
} from "./schemas";

export interface AiCallMeta {
  requestedModel: string;
  servedModel: string;
  fallbackUsed: boolean;
  stopReason: string;
  usage: AiUsage;
  durationMs: number;
  /** Set only by the hosted agent. */
  agent?: AgentCallCost;
  /**
   * A paper's grading only (gradeByReading): how long its READ call(s) and its JUDGE call took, in ms; judgeMs is null when
   * the judge call was skipped (the program marked every item and notes are off).
   */
  steps?: GradingSteps;
}

export interface GradingSteps {
  readMs: number;
  judgeMs: number | null;
}

export interface ExtractKeyInput {
  assignmentTitle: string;
  teacherNotes: string;
  keyPdf: Uint8Array;
  pageCount: number;
}

export interface GradeInput {
  assignment: Pick<Assignment, "title" | "instructions">;
  teacherNotes: string;
  sections: Section[];
  /** Position order; item i is referred to as `Q${i + 1}`. */
  items: KeyItem[];
  studentPdf: Uint8Array;
  studentPageCount: number;
  /** The teacher's preferences and lessons for this assignment; absent means none. */
  guidance?: GradingGuidance;
  /**
   * The assignment's "Write notes for students" (absent = true). Off, the judge is asked for no notes at all and the
   * grading's notes are "".
   */
  writeNotes?: boolean;
  /** Mark detection against the blank worksheet, when the assignment has answer spots (see src/lib/omr). */
  answerSpots?: AnswerSpots | null;
  /** The class list's names: hints for the AI when it transcribes a name crop (never sent with answers). */
  nameHints?: string[];
}

/**
 * Mark detection for one assignment: reads the answer spots of a paper's pages against the blank worksheet, without any AI.
 * `refs` are the items it covers.
 */
export interface AnswerSpots {
  refs: string[];
  /** `pages`: the paper's pages within `pdf` (1-based, in order). */
  read(pdf: Uint8Array, pages: number[], o: { signal?: AbortSignal }): Promise<SpotDetection>;
}

/** What mark detection found on one paper; `ok: false` when it can't be used (the AI then reads every item). */
export type SpotDetection =
  | {
    ok: true; items: DetectedSpot[]; identityPdf: Uint8Array;
    /** The paper's identity spots (name, class) as read, when the assignment's blank asked for them. */
    identity?: IdentityCrop[];
  }
  | { ok: false; reason: "page_count" | "unaligned"; note: string };

export interface DetectedSpot {
  ref: string;
  kind: SpotKind;
  /** Choice: the options' values in printed order. */
  values: string[];
  multi: boolean;
  evidence: SpotEvidence;
  choice?: ChoiceReading;
  written?: WriteInReading;
  /** Something was written: the crop to transcribe (PNG). */
  crop?: { png: Uint8Array; width: number; height: number };
}

/** Crops of answer spots to transcribe: only the student's handwriting, never the question or the key. */
export interface TranscribeInput {
  crops: Array<{ id: string; kind: SpotKind; png: Uint8Array; width: number; height: number }>;
  /**
   * The class list's names, sent only with crops of a name ("name" kind): the reader may use a listed spelling when the
   * writing matches it. Never set on a call with answer crops.
   */
  nameHints?: string[];
}

/** One blank worksheet page as an image, for the AI to find its answer spots. */
export interface ProposeSpotsInput {
  page: { png: Uint8Array; width: number; height: number };
  pageNumber: number;
  /** The key's item labels, so the AI knows which questions to look for. */
  itemLabels: string[];
}

/** The assignment's notes setting; a GradeInput without one writes notes. */
export function writesNotes(i: Pick<GradeInput, "writeNotes">): boolean {
  return i.writeNotes ?? true;
}

/**
 * What the reader is told about an item: never its expected or accepted answers, criteria or points (blindItems copies only
 * these fields, so a KeyItem passed in never carries its answers into a READ request).
 */
export interface BlindItem {
  label: string;
  groupLabel: string;
  answerType: AnswerType;
  prompt: string;
}

export function blindItems(items: ReadonlyArray<BlindItem>): BlindItem[] {
  return items.map((item) => ({ label: item.label, groupLabel: item.groupLabel, answerType: item.answerType, prompt: item.prompt }));
}

/** A READ request for one paper: the pages and the outline of the items, without the answer key. */
export interface ReadInput {
  assignmentTitle: string;
  sections: Section[];
  items: BlindItem[];
  studentPdf: Uint8Array;
  studentPageCount: number;
}

/** A JUDGE request for one paper: the answer key and the teacher's guidance, and the paper's reading (text only, no pages). */
export interface JudgeInput {
  assignment: Pick<Assignment, "title" | "instructions">;
  teacherNotes: string;
  sections: Section[];
  /** Position order, as in GradeInput. */
  items: KeyItem[];
  guidance?: GradingGuidance;
  writeNotes?: boolean;
  /** The items read, in key order: each with its ref, the reader's transcription, and the program's mark (null: judge it). */
  reading: Array<{ ref: string; item: ReadingOutput["items"][number]; mark: AutoMark | null }>;
  unmatchedWork: string;
}

/**
 * One chunk of a whole-class scan, graded in one pass: the chunk is read blind (papers and their transcriptions), then each
 * paper is marked and judged like a paper of its own.
 */
export interface PacketChunkInput extends Omit<GradeInput, "studentPdf" | "studentPageCount"> {
  /** Consecutive pages cut from the scan. */
  chunkPdf: Uint8Array;
  /** The chunk's first page in the scan, 1-based. */
  firstPage: number;
  chunkPageCount: number;
  totalPages: number;
  /** How many pages a paper usually has (a hint), when the key tells. */
  keyPageCount: number | null;
}

/** The READ request of one chunk of a scan read in one pass: no answer key. */
export interface PacketReadInput extends Omit<ReadInput, "studentPdf" | "studentPageCount"> {
  chunkPdf: Uint8Array;
  firstPage: number;
  chunkPageCount: number;
  totalPages: number;
  keyPageCount: number | null;
}

export interface ReadScanInput {
  assignmentTitle: string;
  sections: Section[];
  /** The key items, used only as an outline of the worksheet. */
  items: KeyItem[];
  keyPageCount: number | null;
  /** Consecutive pages cut from the scan. */
  chunkPdf: Uint8Array;
  /** The chunk's first page in the scan, 1-based. */
  firstPage: number;
  chunkPageCount: number;
  totalPages: number;
  /** How the scan page just before the chunk was read, when it was; the chunk's first page is judged against it. */
  previousPage: ScanPreviousPage | null;
}

export interface ScanPreviousPage {
  /** 1-based page in the scan (firstPage - 1). */
  page: number;
  kind: ScanPageKind;
  studentName: string | null;
  worksheetPage: number | null;
  pageMarker: string | null;
}

export interface CallOptions {
  signal?: AbortSignal;
  maxTokens?: number;
}

/** The domain interface every consumer of the AI layer uses; every method rejects with AiError. */
export interface Grader {
  /** "fake" only for the practice grader (AI_MODE=fake); every real engine (Claude, or Ollama on this computer) is "claude". */
  readonly mode: "claude" | "fake";
  /** Which engine this grader is (stored with each grading). */
  readonly engine: "direct" | "agent" | "fake" | "ollama";
  /**
   * Ollama only: papers graded at once (Settings → Grader → "Papers at a time", else OLLAMA_CONCURRENCY). The grader sends at
   * most this many calls to Ollama at once, and the worker runs this many jobs (concurrencyFor).
   */
  readonly parallel?: number;
  /**
   * Crops of written spots best sent in one transcribeCrops call (Ollama: OLLAMA_CROPS_PER_CALL; Claude: CROPS_PER_CALL);
   * absent: DEFAULT_CROPS_PER_CALL.
   */
  readonly cropsPerCall?: number;
  extractKey(i: ExtractKeyInput, o?: CallOptions): Promise<{ output: KeyExtraction; meta: AiCallMeta }>;
  /** READ: transcribes one paper, item by item, without the answer key (with the pages). */
  readSubmission(i: ReadInput, o?: CallOptions): Promise<{ output: ReadingOutput; meta: AiCallMeta }>;
  /**
   * JUDGE: judges the items the program left, from their transcriptions, against the key (text only). The output has the note
   * fields ("" when notes are off; then only the items to judge are returned).
   */
  judgeSubmission(i: JudgeInput, o?: CallOptions): Promise<{ output: JudgingOutput; meta: AiCallMeta }>;
  /** READ, MARK and JUDGE for one paper (gradeByReading over this grader's readSubmission and judgeSubmission). */
  gradeSubmission(i: GradeInput, o?: CallOptions): Promise<{ output: GradingOutput; refs: string[]; meta: AiCallMeta }>;
  readScanPages(i: ReadScanInput, o?: CallOptions): Promise<{ output: ScanPages; meta: AiCallMeta }>;
  /** READ of one chunk of a scan in one pass. Absent on an engine that can't (the hosted agent). */
  readPacketChunk?(i: PacketReadInput, o?: CallOptions): Promise<{ output: PacketReadingOutput; meta: AiCallMeta }>;
  /**
   * Finds the papers in one chunk of a scan and grades each (gradePacketByReading: READ the chunk, then MARK and JUDGE each
   * paper; `output` always has the note fields, "" when notes are off). Present exactly when readPacketChunk is; absent, a scan
   * is split first and each paper graded on its own.
   */
  gradePacketChunk?(i: PacketChunkInput, o?: CallOptions): Promise<{ output: PacketOutput; refs: string[]; meta: AiCallMeta }>;
  /** Mark detection: transcribes crops of written answer spots (no question, no answers). Absent: the AI reads those items. */
  transcribeCrops?(i: TranscribeInput, o?: CallOptions): Promise<{ output: CropTranscriptions; meta: AiCallMeta }>;
  /** A scanned blank worksheet: proposes the answer spots of one page (the teacher confirms them). */
  proposeSpots?(i: ProposeSpotsInput, o?: CallOptions): Promise<{ output: SpotProposal; meta: AiCallMeta }>;
}
