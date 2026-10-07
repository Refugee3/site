import type { AiUsage, Assignment, GradingGuidance, KeyItem, Section } from "@/lib/types";
import type { GradingOutput, KeyExtraction, ScanPages } from "./schemas";

export interface AiCallMeta {
  requestedModel: string;
  servedModel: string;
  fallbackUsed: boolean;
  stopReason: string;
  usage: AiUsage;
  durationMs: number;
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
}

export interface CallOptions {
  signal?: AbortSignal;
  maxTokens?: number;
}

/** The domain interface every consumer of the AI layer uses; every method rejects with AiError. */
export interface Grader {
  readonly mode: "claude" | "fake";
  extractKey(i: ExtractKeyInput, o?: CallOptions): Promise<{ output: KeyExtraction; meta: AiCallMeta }>;
  gradeSubmission(i: GradeInput, o?: CallOptions): Promise<{ output: GradingOutput; refs: string[]; keyPdfIncluded: boolean; meta: AiCallMeta }>;
  readScanPages(i: ReadScanInput, o?: CallOptions): Promise<{ output: ScanPages; meta: AiCallMeta }>;
}
