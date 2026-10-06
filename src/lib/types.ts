export const ASSIGNMENT_STATUSES = ["draft", "open", "closed"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const GRADING_MODES = ["completion", "accuracy", "blended"] as const;
export type GradingMode = (typeof GRADING_MODES)[number];
export const KEY_STATUSES = ["empty", "processing", "ready", "failed"] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];
export const SUBMISSION_STATUSES = ["queued", "grading", "graded", "needs_review", "failed"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
export const ANSWER_TYPES = ["multiple_choice", "true_false", "numeric", "short_answer", "long_answer", "fill_in_blank", "matching", "diagram", "other"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
export const ANSWER_SOURCES = ["key", "ai_proposed", "teacher"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];
export const ATTEMPTS = ["complete", "partial", "none"] as const;
export type Attempt = (typeof ATTEMPTS)[number];
export const CORRECTNESS = ["correct", "minor_error", "partially_correct", "major_error", "incorrect", "no_answer", "cannot_judge"] as const;
export type Correctness = (typeof CORRECTNESS)[number];
export const LEGIBILITY = ["clear", "partly_illegible", "illegible", "no_writing"] as const;
export type Legibility = (typeof LEGIBILITY)[number];
export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const ITEM_REVIEW_REASONS = ["none", "alternate_answer", "key_may_be_wrong", "multiple_answers", "ambiguous_reading", "other"] as const;
export type ItemReviewReason = (typeof ITEM_REVIEW_REASONS)[number];
export const DOCUMENT_MATCHES = ["matches", "uncertain", "different_assignment", "not_student_work", "blank"] as const;
export type DocumentMatch = (typeof DOCUMENT_MATCHES)[number];
export const FLAG_CODES = ["name_missing", "name_unclear", "name_uncertain", "section_unmatched", "section_inferred", "multiple_students",
  "wrong_assignment", "blank_submission", "pages_missing", "low_confidence", "illegible", "item_review", "grader_directed_text",
  "output_repaired", "ai_refused", "manual_grading", "fallback_model"] as const;
export type FlagCode = (typeof FLAG_CODES)[number];
export type JobKind = "extract_key" | "grade_submission";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Teacher { id: string; email: string; displayName: string; createdAt: number }
export interface Assignment { id: string; teacherId: string; title: string; instructions: string; status: AssignmentStatus;
  gradingMode: GradingMode; accuracyWeight: number; shareCode: string; maxSubmissions: number; feedbackReleasedAt: number | null;
  createdAt: number; updatedAt: number }
export interface Section { id: string; assignmentId: string; label: string; aliases: string[]; canonicalKey: string; sortOrder: number }
export interface AiUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface AnswerKey { assignmentId: string; status: KeyStatus; sourcePdfPath: string | null; sourceFilename: string | null;
  sourceSha256: string | null; sourcePageCount: number | null; documentKind: string | null; teacherNotes: string; aiNotes: string;
  revision: number; approvedRevision: number | null; fingerprint: string | null; errorMessage: string | null; aiModel: string | null;
  usage: AiUsage | null; updatedAt: number }
export interface KeyItem { id: string; assignmentId: string; position: number; label: string; groupLabel: string; prompt: string;
  answerType: AnswerType; expectedAnswer: string; acceptableAnswers: string[]; gradingCriteria: string; pointsCenti: number;
  partialCredit: boolean; page: number | null; answerSource: AnswerSource; aiConfidence: Confidence | null; aiNote: string }
export type NewKeyItem = Omit<KeyItem, "id" | "assignmentId" | "position">;
export interface ItemJudgment { attempt: Attempt; correctness: Correctness; legibility: Legibility; confidence: Confidence;
  reviewReason: ItemReviewReason; studentAnswer: string; pages: number[]; whatStudentDid: string; feedback: string; teacherNote: string }
export interface SubmissionItem { submissionId: string; itemId: string; judgment: ItemJudgment | null; overrideCenti: number | null;
  overrideFeedback: string | null; updatedAt: number }
export interface Submission { id: string; assignmentId: string; source: "student" | "teacher"; receiptToken: string; pdfPath: string;
  originalFilename: string; contentSha256: string; byteSize: number; pageCount: number; status: SubmissionStatus; statusNote: string | null;
  gradingGeneration: number; gradedKeyRevision: number | null; aiName: string | null; aiNameConfidence: Confidence | null;
  aiSectionRaw: string | null; aiSectionMatch: string | null; studentName: string | null; nameSource: "ai" | "teacher" | null;
  nameKey: string | null; nameSortKey: string; sectionId: string | null; sectionKey: string | null; sectionSource: "ai" | "teacher" | null;
  documentMatch: DocumentMatch | null; flags: FlagCode[]; overallFeedback: string; overallFeedbackEdited: boolean; teacherSummary: string;
  integrityNote: string; unmatchedWork: string; totalOverrideCenti: number | null; scoreEarnedCenti: number | null;
  scoreMaxCenti: number | null; completionCenti: number | null; accuracyCenti: number | null; aiModel: string | null;
  usage: AiUsage | null; errorCode: string | null; errorMessage: string | null; gradedAt: number | null; reviewedAt: number | null;
  createdAt: number; updatedAt: number }
export interface Job { id: number; kind: JobKind; targetId: string; assignmentId: string; status: JobStatus; priority: number;
  attempts: number; maxAttempts: number; runAfter: number; maxTokens: number | null; lastError: string | null; createdAt: number; updatedAt: number;
  finishedAt: number | null }

export interface ItemScore { itemId: string; maxCenti: number; computedCenti: number | null; earnedCenti: number; overridden: boolean }
export interface ScoreResult { items: ItemScore[]; earnedCenti: number; maxCenti: number; percentTenths: number | null;
  completionCenti: number; accuracyCenti: number; totalOverridden: boolean; judgedCount: number }

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
export interface AssignmentFormInput { title: string; instructions: string; gradingMode: GradingMode; accuracyWeight: number; sectionsText: string; maxSubmissions: number }
export interface SaveKeyInput { teacherNotes: string; acknowledgeAiProposed: boolean; items: Array<{ id: string | null; label: string;
  groupLabel: string; prompt: string; answerType: AnswerType; expectedAnswer: string; acceptableAnswers: string[]; gradingCriteria: string;
  pointsCenti: number; partialCredit: boolean; page: number | null }> }

// ---- view models (produced by src/lib/services/views.ts) ----
export interface WorkerStatus { state: "running" | "paused" | "stopped"; reason: string | null; aiMode: "claude" | "fake"; queued: number; running: number }
export type StatusCounts = Record<SubmissionStatus, number> & { total: number };
export interface DashboardView { teacher: Teacher; worker: WorkerStatus | null; assignments: Array<{ id: string; title: string;
  status: AssignmentStatus; shareCode: string; keyStatus: KeyStatus; keyApproved: boolean; counts: StatusCounts; released: boolean; createdAt: number }> }
export interface AssignmentHeader { assignment: Assignment; shareUrl: string; keyStatus: KeyStatus; keyApproved: boolean; itemCount: number;
  totalPointsCenti: number; counts: StatusCounts; staleCount: number; canOpen: boolean; worker: WorkerStatus | null }
export type BoardFilter = "all" | "needs_review" | "in_progress" | "failed" | "graded";
export interface BoardRow { submissionId: string; displayName: string; status: SubmissionStatus; statusNote: string | null;
  source: "student" | "teacher"; scoreEarnedCenti: number | null; scoreMaxCenti: number | null; percentTenths: number | null;
  flags: FlagCode[]; stale: boolean; earlier: Array<{ submissionId: string; createdAt: number; status: SubmissionStatus }>; pageCount: number; createdAt: number }
export interface BoardView { filter: BoardFilter; groups: Array<{ key: string; label: string; rows: BoardRow[] }>; counts: StatusCounts;
  staleCount: number; active: boolean; open: boolean }
export interface KeyEditorView { key: AnswerKey; items: KeyItem[]; keyPdfUrl: string | null; gradedCount: number; locked: boolean }
export interface ReviewItemView { item: KeyItem; result: SubmissionItem | null; score: ItemScore }
export interface ReviewView { submission: Submission; sections: Section[]; sectionLabel: string | null; items: ReviewItemView[];
  score: ScoreResult; flags: Array<{ code: FlagCode; severity: "review" | "info"; label: string; description: string }>;
  stale: boolean; pdfUrl: string; receiptUrl: string; prevId: string | null; nextId: string | null; nextNeedsReviewId: string | null;
  earlierAttempts: Array<{ submissionId: string; createdAt: number; status: SubmissionStatus }> }
export interface SettingsView { sectionsText: string; usage: { papers: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd: number | null } }
export interface StudentUploadView { code: string; title: string; instructions: string; teacherName: string; status: AssignmentStatus;
  accepting: boolean; maxUploadMb: number; maxPages: number; maxFiles: number }
export type ReceiptPhase = "processing" | "checked" | "released" | "problem";
export type ReceiptNotice = "no_name" | "wrong_assignment" | "blank" | "pages_missing";
export interface ReceiptView { assignmentTitle: string; shareCode: string; submittedAt: number; pageCount: number; phase: ReceiptPhase;
  pdfUrl: string; detectedName: string | null; detectedSection: string | null; notices: ReceiptNotice[];
  result: null | { earnedCenti: number; maxCenti: number; percentTenths: number | null; overallFeedback: string;
    groups: Array<{ groupLabel: string; items: Array<{ label: string; earnedCenti: number; maxCenti: number; whatStudentDid: string; feedback: string }> }> } }
