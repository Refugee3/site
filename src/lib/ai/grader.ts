import type { AiUsage, Assignment, KeyItem, Section } from "@/lib/types";
import type { GradingOutput, KeyExtraction } from "./schemas";

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
}

export interface CallOptions {
  signal?: AbortSignal;
  maxTokens?: number;
}

/** The domain interface every consumer of the AI layer uses; both methods reject with AiError. */
export interface Grader {
  readonly mode: "claude" | "fake";
  extractKey(i: ExtractKeyInput, o?: CallOptions): Promise<{ output: KeyExtraction; meta: AiCallMeta }>;
  gradeSubmission(i: GradeInput, o?: CallOptions): Promise<{ output: GradingOutput; refs: string[]; keyPdfIncluded: boolean; meta: AiCallMeta }>;
}
