import type { AiUsage, Assignment, GradingGuidance, KeyItem, ScanPageKind, Section } from "@/lib/types";
import type { AgentCallCost } from "./errors";
import type { GradingOutput, KeyExtraction, PacketOutput, ScanPages } from "./schemas";

export interface AiCallMeta {
  requestedModel: string;
  servedModel: string;
  fallbackUsed: boolean;
  stopReason: string;
  usage: AiUsage;
  durationMs: number;
  /** Set only by the hosted agent. */
  agent?: AgentCallCost;
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
  keyPdf: Uint8Array | null;
  studentPdf: Uint8Array;
  studentPageCount: number;
  /** The teacher's preferences and lessons for this assignment; absent means none. */
  guidance?: GradingGuidance;
  /**
   * The assignment's "Write notes for students" (absent = true). Off, the AI is asked for no notes at all and the
   * grader returns them as "" (withEmptyNotes).
   */
  writeNotes?: boolean;
}

/** The assignment's notes setting; a GradeInput without one writes notes. */
export function writesNotes(i: Pick<GradeInput, "writeNotes">): boolean {
  return i.writeNotes ?? true;
}

/**
 * One chunk of a whole-class scan, graded in one pass: the same class-shared prefix as GradeInput (key PDF, context,
 * guidance), then the chunk's pages, which may hold several students' papers.
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
  readonly mode: "claude" | "fake";
  /** Which engine this grader is (stored with each grading). */
  readonly engine: "direct" | "agent" | "fake";
  extractKey(i: ExtractKeyInput, o?: CallOptions): Promise<{ output: KeyExtraction; meta: AiCallMeta }>;
  gradeSubmission(i: GradeInput, o?: CallOptions): Promise<{ output: GradingOutput; refs: string[]; keyPdfIncluded: boolean; meta: AiCallMeta }>;
  readScanPages(i: ReadScanInput, o?: CallOptions): Promise<{ output: ScanPages; meta: AiCallMeta }>;
  /**
   * Finds the papers in one chunk of a scan and grades each (`output` always has the note fields; "" when notes are off).
   * Absent on an engine that can't (the hosted agent): a scan is then split first and each paper graded on its own.
   */
  gradePacketChunk?(i: PacketChunkInput, o?: CallOptions): Promise<{ output: PacketOutput; refs: string[]; keyPdfIncluded: boolean; meta: AiCallMeta }>;
}
