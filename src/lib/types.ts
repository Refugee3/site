import type { OllamaSettings } from "@/lib/ollama-settings";
import type { SpotEvidence } from "@/lib/omr/types";

export const ASSIGNMENT_STATUSES = ["draft", "open", "closed"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const ASSIGNMENT_KINDS = ["homework", "quiz"] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];
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
/** What a clarifying question the AI asks the teacher about the key is about (see grading/key-questions.ts for how answers apply). */
export const KEY_QUESTION_KINDS = ["missing_answer", "points", "partial_credit", "accept_equivalents", "ambiguous_item", "other"] as const;
export type KeyQuestionKind = (typeof KEY_QUESTION_KINDS)[number];
export const KEY_QUESTION_STATUSES = ["pending", "answered", "skipped"] as const;
export type KeyQuestionStatus = (typeof KEY_QUESTION_STATUSES)[number];
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
  "wrong_assignment", "blank_submission", "pages_missing", "paper_boundary", "low_confidence", "illegible", "item_review", "grader_directed_text",
  "output_repaired", "ai_refused", "manual_grading", "fallback_model", "worksheet_unaligned"] as const;
export type FlagCode = (typeof FLAG_CODES)[number];
export type JobKind = "extract_key" | "grade_submission" | "split_scan";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Teacher { id: string; email: string; displayName: string; createdAt: number }
export interface Assignment { id: string; teacherId: string; title: string; kind: AssignmentKind; instructions: string; status: AssignmentStatus;
  /** The AI writes notes for the student and the teacher; off, it only judges (cheaper). */
  writeNotes: boolean;
  gradingMode: GradingMode; accuracyWeight: number; shareCode: string; maxSubmissions: number; feedbackReleasedAt: number | null;
  createdAt: number; updatedAt: number }
export interface Section { id: string; assignmentId: string; label: string; aliases: string[]; canonicalKey: string; sortOrder: number }
export interface AiUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface AnswerKey { assignmentId: string; status: KeyStatus; sourcePdfPath: string | null; sourceFilename: string | null;
  sourceSha256: string | null; sourcePageCount: number | null; documentKind: string | null; teacherNotes: string; aiNotes: string;
  revision: number; approvedRevision: number | null; fingerprint: string | null; errorMessage: string | null; aiModel: string | null;
  usage: AiUsage | null;
  /** When the key last went to processing (upload or "read again"), and when the AI's reading of it was stored. */
  processingStartedAt: number | null; processingFinishedAt: number | null;
  updatedAt: number }
export interface KeyItem { id: string; assignmentId: string; position: number; label: string; groupLabel: string; prompt: string;
  answerType: AnswerType; expectedAnswer: string; acceptableAnswers: string[]; gradingCriteria: string; pointsCenti: number;
  partialCredit: boolean; page: number | null; answerSource: AnswerSource; aiConfidence: Confidence | null; aiNote: string }
export type NewKeyItem = Omit<KeyItem, "id" | "assignmentId" | "position">;
/**
 * A question the AI asked about the key while reading it (key_questions). `itemLabel` names the key item it is about, as the AI
 * printed it; `answer` is the teacher's, once answered.
 */
export interface KeyQuestion { id: string; assignmentId: string; position: number; kind: KeyQuestionKind; itemLabel: string | null;
  question: string; suggestedAnswer: string | null; choices: string[]; status: KeyQuestionStatus; answer: string | null;
  answeredAt: number | null; createdAt: number; updatedAt: number }
export type NewKeyQuestion = Pick<KeyQuestion, "kind" | "itemLabel" | "question" | "suggestedAnswer" | "choices">;
/**
 * Who decided an item's correctness: `program` = compared in code with the key (an exact match, a blank, an unreadable answer),
 * `ai` = judged by the AI from the blind transcription.
 */
export const JUDGED_BY = ["program", "ai"] as const;
export type JudgedBy = (typeof JUDGED_BY)[number];
export interface ItemJudgment { attempt: Attempt; correctness: Correctness; legibility: Legibility; confidence: Confidence;
  reviewReason: ItemReviewReason; studentAnswer: string; pages: number[]; whatStudentDid: string; feedback: string; teacherNote: string;
  /** Absent for gradings stored before the paper was read without the key (and for judgments that never had one). */
  judgedBy?: JudgedBy;
  /** What the reader saw of the student's marks ("B circled, A crossed out"); absent or "" when there was nothing to add. */
  marksSeen?: string;
  /** Read by mark detection from the blank worksheet's answer spot (the review page shows its crop); absent otherwise. */
  spot?: SpotEvidence }
export interface SubmissionItem { submissionId: string; itemId: string; judgment: ItemJudgment | null; overrideCenti: number | null;
  overrideFeedback: string | null; overrideWhatStudentDid: string | null; updatedAt: number }
export interface Submission { id: string; assignmentId: string; source: "student" | "teacher"; receiptToken: string; pdfPath: string;
  originalFilename: string; contentSha256: string; clientUploadId: string | null; byteSize: number; pageCount: number; status: SubmissionStatus; statusNote: string | null;
  gradingGeneration: number; gradedKeyRevision: number | null; gradedGuidanceFp: string | null; aiName: string | null; aiNameConfidence: Confidence | null;
  aiSectionRaw: string | null; aiSectionMatch: string | null; studentName: string | null; nameSource: "ai" | "teacher" | null;
  nameKey: string | null; nameSortKey: string; sectionId: string | null; sectionKey: string | null; sectionSource: "ai" | "teacher" | null;
  documentMatch: DocumentMatch | null; flags: FlagCode[]; overallFeedback: string; overallFeedbackEdited: boolean; teacherSummary: string;
  integrityNote: string; unmatchedWork: string; totalOverrideCenti: number | null; scoreEarnedCenti: number | null;
  scoreMaxCenti: number | null; completionCenti: number | null; accuracyCenti: number | null; aiModel: string | null;
  aiEngine: GraderEngine | null; usage: AiUsage | null; errorCode: string | null; errorMessage: string | null; gradedAt: number | null;
  reviewedAt: number | null;
  /** When the current grading run started (status → grading); null while queued. Kept after grading: graded_at minus it is how long it took. */
  gradingStartedAt: number | null;
  /** When the paper was last queued (upload or regrade): the grading batch it belongs to. */
  queuedAt: number;
  /** How long the stored grading's reading and judging took (ms); judgeMs null when no judge call was needed or not recorded. */
  readMs: number | null; judgeMs: number | null;
  createdAt: number; updatedAt: number }
export interface Job { id: number; kind: JobKind; targetId: string; assignmentId: string; status: JobStatus; priority: number;
  attempts: number; maxAttempts: number; runAfter: number; maxTokens: number | null; lastError: string | null; createdAt: number; updatedAt: number;
  finishedAt: number | null; paused: boolean }

export interface ItemScore { itemId: string; maxCenti: number; computedCenti: number | null; earnedCenti: number; overridden: boolean }
export interface ScoreResult { items: ItemScore[]; earnedCenti: number; maxCenti: number; percentTenths: number | null;
  completionCenti: number; accuracyCenti: number; totalOverridden: boolean; judgedCount: number }

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
export interface AssignmentFormInput { title: string; kind: AssignmentKind; instructions: string; gradingMode: GradingMode; accuracyWeight: number; sectionsText: string; maxSubmissions: number;
  writeNotes: boolean }
export interface SaveKeyInput { teacherNotes: string; acknowledgeAiProposed: boolean; items: Array<{ id: string | null; label: string;
  groupLabel: string; prompt: string; answerType: AnswerType; expectedAnswer: string; acceptableAnswers: string[]; gradingCriteria: string;
  pointsCenti: number; partialCredit: boolean; page: number | null }> }

// ---- view models (produced by src/lib/services/views.ts) ----
export interface WorkerStatus { state: "running" | "paused" | "stopped"; reason: string | null; aiMode: "claude" | "fake"; queued: number; running: number;
  /**
   * Grading can't run because there is no key at all, or Anthropic rejected the key in use; `agent`: paused because the
   * hosted agent isn't available with the key in use; `ollama`: paused because Ollama on this computer can't be used (not
   * running, model not downloaded…), fixed in Settings → Grader or by starting Ollama.
   */
  keyIssue: "missing" | "rejected" | "agent" | "ollama" | null;
  /** GRADING_CONCURRENCY: the most jobs the worker runs at once. */
  concurrency: number;
  /** How many it runs at once now: halved after a rate limit or overload, then back up by one per job that finishes. */
  effectiveConcurrency: number;
  /** While set (ms), the worker starts no new job: Anthropic asked it to slow down. Grading continues afterwards. */
  throttledUntil: number | null }
export type StatusCounts = Record<SubmissionStatus, number> & { total: number };
/**
 * Scans still waiting: being split by the AI, split and waiting for the teacher's check, or failed to split. `onePass`: how
 * many of the `splitting` ones are being graded in one pass (no split to check).
 */
export interface PendingScans { splitting: number; onePass: number; review: number; failed: number; firstReviewId: string | null }
/**
 * The assignment's current grading batch: papers queued since its queue last went from empty to non-empty (an upload, a
 * scan's papers, a regrade). Timestamps are epoch ms, durations ms. Null in the views while nothing is queued or grading.
 */
export interface GradingProgress {
  /** Papers of the batch that are graded, need review, or failed. */
  done: number;
  /** done + queued + grading. */
  total: number;
  queued: number;
  grading: number;
  /** When the batch started (its first paper was queued). */
  startedAt: number;
  /** Median of the recent paper gradings: this assignment's last 20, else every assignment's, else 60 000. */
  typicalPaperMs: number;
  /**
   * Estimated ms until the batch is done: the worker's current concurrency as slots, each paper being graded holding its slot
   * for max(0, typicalPaperMs - its elapsed time), each queued paper then taking the first free slot for typicalPaperMs
   * (≈ ceil(queued / concurrency) × typicalPaperMs when nothing is in flight). Shrinks as time passes; 0 = finishing up.
   * With scans graded in one pass, the longest of that and their own estimates.
   */
  etaMs: number;
  /**
   * Scans being graded in one pass: their papers count in `done` as they are graded; `remainingPapers` (in `total`, not in
   * `queued`) is about how many more they will grade. Null when there is none.
   */
  onePass: { scans: number; remainingPapers: number } | null;
}
/** A whole-class scan being read by the AI. */
export interface ScanSplitProgress {
  /** When the split was queued (upload or "try the AI again"), epoch ms. */
  splitStartedAt: number;
  pagesRead: number;
  pageCount: number;
  /**
   * max(0, pageCount × typical ms per page - ms since splitStartedAt); typical: median of recent splits, else 2 000 per page.
   * Grading in one pass: the pages still to read × the time per page so far (before the first chunk: recent one-pass scans,
   * else 10 000 per page).
   */
  etaMs: number;
  /** Grading in one pass: papers graded so far (null for a split). */
  papersGraded: number | null;
}
export interface DashboardView { assignments: Array<{ id: string; title: string; kind: AssignmentKind;
  keyStatus: KeyStatus; keyApproved: boolean; counts: StatusCounts; scans: PendingScans; createdAt: number;
  /** The current grading batch (see GradingProgress); null while nothing is queued or grading. */
  progress: { done: number; total: number } | null }> }
/** A question most of a class missed, on the dashboard's "Where students are struggling" (see getStrugglingQuestions). */
export interface StrugglingQuestion { assignmentId: string; assignmentTitle: string; kind: AssignmentKind; itemId: string; label: string;
  prompt: string;
  /** The miss rate (see item-stats.ts), in tenths of a percent; above 500. */
  missedTenths: number;
  /** Students (current papers) who didn't get full credit, of `judged`. */
  missedPapers: number; judged: number }
export interface AssignmentHeader { assignment: Assignment; keyStatus: KeyStatus; keyApproved: boolean; itemCount: number;
  totalPointsCenti: number; counts: StatusCounts; scans: PendingScans }
export type BoardFilter = "all" | "needs_review" | "in_progress" | "failed" | "graded";
export interface BoardRow { submissionId: string; displayName: string; status: SubmissionStatus; statusNote: string | null;
  scoreEarnedCenti: number | null; scoreMaxCenti: number | null; percentTenths: number | null;
  flags: FlagCode[]; stale: boolean; earlier: Array<{ submissionId: string; createdAt: number; status: SubmissionStatus }>; pageCount: number; createdAt: number;
  /** Only while the board is filtered to the papers that missed an item: how this paper did on it and what it wrote. */
  missed?: { outcome: ItemOutcome; answer: string } }
/**
 * How one paper did on one key item (see src/lib/grading/item-stats.ts). `partly`: a minor error, partially correct or a
 * major error; `blank`: not attempted or no answer; `unreadable`: the AI couldn't judge it.
 */
export type ItemOutcome = "correct" | "partly" | "wrong" | "blank" | "unreadable";
export interface BoardView { groups: Array<{ key: string; label: string; rows: BoardRow[] }>; counts: StatusCounts;
  scans: PendingScans; staleCount: number; guidanceStaleCount: number; active: boolean;
  /** The answer key is approved, so papers can be uploaded. */
  keyApproved: boolean;
  /**
   * `?missed=<itemId>`: the board shows only the current graded papers that missed that item (anything short of full
   * accuracy credit), with the answers written most often among them. Null without the filter or for an unknown item.
   */
  missed: { itemId: string; label: string; prompt: string; count: number; commonAnswers: Array<{ answer: string; count: number }> } | null;
  /** Null while none of the assignment's papers is queued or being graded. */
  progress: GradingProgress | null }
export interface KeyEditorView { key: AnswerKey; items: KeyItem[]; keyPdfUrl: string | null; gradedCount: number; locked: boolean;
  /** Only while the key is processing: when it went to processing (epoch ms) and the median of the last 20 readings (else 45 000). */
  extraction: { extractionStartedAt: number; typicalExtractionMs: number } | null }
export interface ReviewItemView { item: KeyItem; result: SubmissionItem | null; score: ItemScore;
  /** `sent`: the grader is sent it now; otherwise `notSent` says why (as on the Lessons tab). */
  lesson: { id: string; reason: string; active: boolean; sent: boolean; notSent: LessonNotSentReason | null } | null }
export interface ReviewView { submission: Submission; sections: Section[]; sectionLabel: string | null; items: ReviewItemView[];
  score: ScoreResult; stale: boolean; pdfUrl: string; prevId: string | null; nextId: string | null; nextNeedsReviewId: string | null;
  earlierAttempts: Array<{ submissionId: string; createdAt: number; status: SubmissionStatus }>; guidanceStale: boolean;
  /** The engine that would grade this paper now; null without a usable key. */
  gradingEngine: GraderEngine | null;
  /** Only while the paper is queued: how many queued papers (of every assignment) the worker takes before it; 0 = next. */
  queue: { position: number } | null;
  /** Only while the paper is being graded: when this run started (epoch ms), and how long a paper typically takes. */
  gradingTiming: { gradingStartedAt: number; typicalPaperMs: number } | null }
export interface SettingsView { sectionsText: string; usage: { calls: number; papers: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd: number | null; agentSessions: number; agentActiveSeconds: number } }

// ---- v2: scans ----
export const SCAN_STATUSES = ["splitting", "review", "creating", "done", "failed"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
/** `auto`: the AI splits, then each paper is graded; `every`: every N pages; `one_pass`: each page is read once, split and graded together. */
export type ScanSplitMode = "auto" | "every" | "one_pass";
export const SCAN_PAGE_KINDS = ["student_work", "blank", "cover_or_separator", "answer_key", "other"] as const;
export type ScanPageKind = (typeof SCAN_PAGE_KINDS)[number];
/** What the AI read on one scanned page; `reported:false` = a placeholder for a page the AI skipped. */
export interface ScanPageReading { kind: ScanPageKind; startsNewPaper: boolean; studentName: string | null; sectionRaw: string | null;
  pageMarker: string | null; worksheetPage: number | null; confidence: Confidence; note: string; reported: boolean }
export interface ScanLayoutPage { startsPaper: boolean; dropped: boolean }
/** One entry per scanned page (index = page - 1). */
export type ScanLayout = ScanLayoutPage[];
export interface Scan { id: string; assignmentId: string; status: ScanStatus; splitMode: ScanSplitMode; pagesPerPaper: number | null;
  splitGeneration: number; pdfPath: string; originalFilename: string; contentSha256: string; byteSize: number; pageCount: number;
  readings: Array<ScanPageReading | null>; pagesRead: number; layout: ScanLayout | null; proposedLayout: ScanLayout | null;
  statusNote: string | null; errorMessage: string | null; aiModel: string | null; usage: AiUsage | null;
  createdCount: number | null; duplicateCount: number | null;
  /** When the AI split was queued (upload or "try the AI again"), and when it finished reading every page. */
  splitStartedAt: number | null; splitFinishedAt: number | null;
  /** The AI's split had nothing to check, so its papers were created and queued for grading without the teacher. */
  autoGraded: boolean;
  /** Grading in one pass (splitMode one_pass): how far it got; null before the first chunk and for other modes. */
  onePass: OnePassProgress | null;
  createdAt: number; updatedAt: number }

/** Why a page of a scan graded in one pass is part of no paper; `unassigned`: the AI put it in no paper and gave no reason. */
export type SkippedPageReason = "blank" | "cover_or_separator" | "answer_key" | "other" | "unassigned";
export interface SkippedPage { page: number; reason: SkippedPageReason }
/** A paper of a scan graded in one pass (1-based scan pages); `submissionId` null: the same pages were already uploaded. */
export interface OnePassPaper { firstPage: number; lastPage: number; submissionId: string | null; flagged: boolean }
/**
 * A scan graded in one pass, chunk by chunk in page order. A chunk's AI answer is saved (`pending`) before its papers are
 * stored, so a run that stops partway resumes there without paying for the call again.
 */
export interface OnePassProgress {
  /** The first page of the next chunk (1-based); pageCount + 1 once every page was read. */
  nextPage: number;
  /** The last chunk ended where a paper ends (true before the first chunk). */
  endedCleanly: boolean;
  /** Chunks finished. */
  chunks: number;
  /** At most this many pages per chunk after the AI ran out of room for its answer; null = the configured size. */
  maxChunkPages: number | null;
  papers: OnePassPaper[];
  skipped: SkippedPage[];
  pending: OnePassPendingChunk | null;
}
/** An AI answer for one chunk whose papers are not all stored yet. */
export interface OnePassPendingChunk {
  /** Scan pages of the chunk, 1-based. */
  firstPage: number;
  lastPage: number;
  /** The PacketOutput (notes filled in as "" when they were off). */
  output: unknown;
  /** The key items as they were sent (refs Q1… in this order). */
  items: Array<{ id: string; label: string }>;
  keyRevision: number;
  guidanceFingerprint: string;
  servedModel: string;
  fallbackUsed: boolean;
  engine: GraderEngine;
  usage: AiUsage;
  /** Papers of the chunk stored so far (in chunk order). */
  stored: number;
}

// ---- v2: lessons and guidance ----
export interface Lesson { id: string; assignmentId: string; itemId: string; submissionId: string | null; studentAnswer: string;
  aiAttempt: Attempt | null; aiCorrectness: Correctness | null; teacherAttempt: Attempt | null; teacherCorrectness: Correctness | null;
  overrideCenti: number | null; feedback: string | null; whatStudentDid: string | null; reason: string; active: boolean;
  createdAt: number; updatedAt: number }
/**
 * A lesson as sent to the grader (fields already truncated by toGuidanceLesson). `exact` is null when the teacher kept
 * the AI's points, else whether the teacher's ruling scores exactly `overrideCenti` under the assignment's current scoring.
 */
export interface GuidanceLesson { itemId: string; studentAnswer: string; aiAttempt: Attempt | null; aiCorrectness: Correctness | null;
  teacherAttempt: Attempt | null; teacherCorrectness: Correctness | null; overrideCenti: number | null; exact: boolean | null;
  reason: string; feedback: string | null; whatStudentDid: string | null }
/** `lessons` in recency order (newest first), already selected and capped. */
export interface GradingGuidance { preferences: string; lessons: GuidanceLesson[] }
/** `reading_fix`: the AI could not read the answer (blank, illegible, cannot judge) and the teacher gave no reason. */
export type LessonNotSentReason = "inactive" | "agrees" | "no_reading" | "reading_fix" | "limit" | "unknown_item";

// ---- v2: view models ----
export type ApiKeySource = "app" | "env" | "none";
/**
 * Settings → Grader → On this computer (Ollama), speed: the saved page image size and papers at a time (null = not set), the
 * server's fallbacks (OLLAMA_IMAGE_MAX_EDGE, null when unset; OLLAMA_CONCURRENCY), and how long the last papers graded on this
 * computer took (median of reading + judging, ms; null before any).
 */
export interface OllamaSpeedView { imageMaxEdge: number | null; papersAtATime: number | null; envImageMaxEdge: number | null;
  envConcurrency: number; recent: { papers: number; medianMs: number; medianReadMs: number; medianJudgeMs: number } | null }
export interface TeacherSettingsView {
  apiKey: { source: ApiKeySource; masked: string | null; check: "verified" | "unverified" | null; setAt: number | null;
    setByName: string | null; unreadable: boolean; envKeySet: boolean };
  aiMode: "claude" | "fake";
  /** Settings → AI model: reads answer keys and grades papers, with either engine. */
  aiModel: AiModel; gradingPreferences: string; worker: WorkerStatus | null;
  grader: { engine: GradingEngineChoice; /** null in AI_MODE=fake or without a usable key */ agent: HostedAgentStatusView | null;
    /** Settings → Grader → On this computer (Ollama): the saved address, model and context size. */
    ollama: OllamaSettings } }
/** `paperDeleted`: the paper the correction was made on was deleted (`paperHref` is then null); the lesson can be deleted. */
export interface LessonView { lesson: Lesson; itemLabel: string; itemPosition: number; itemMaxCenti: number; sent: boolean;
  notSent: LessonNotSentReason | null; paperHref: string | null; paperDeleted: boolean }
export interface LessonsView { lessons: LessonView[] /* key order, then newest first */; activeCount: number; sentCount: number;
  guidanceStaleCount: number; hasPreferences: boolean }
export interface ScanSummary { id: string; status: ScanStatus; splitMode: ScanSplitMode; originalFilename: string; pageCount: number; createdAt: number; createdCount: number | null;
  /** The AI's split looked clean, so its papers were created and queued for grading without the teacher. */
  autoGraded: boolean }
export interface UploadPageView { keyApproved: boolean; keyPageCount: number | null; scans: ScanSummary[]; maxUploadMb: number; maxPages: number;
  maxScanMb: number; maxScanPages: number;
  /** False while the hosted agent grades: a scan uploaded to be graded in one pass is then split first. */
  onePassAvailable: boolean }
/** `scan.autoGraded`: the split looked clean, so grading started automatically ("Split looked clean — grading started automatically."). */
export interface ScanReviewView { scan: Omit<Scan, "pdfPath" | "contentSha256" | "aiModel" | "usage" | "onePass">;
  /** Grading in one pass: papers graded and pages left out so far (no AI answers). Null for other modes. */
  onePass: { papersGraded: number; duplicates: number; flagged: number; pagesDone: number; skipped: SkippedPage[] } | null;
  pdfUrl: string /* /api/teacher/scans/<id>/pdf */;
  keyApproved: boolean; keyPageCount: number | null; maxPagesPerPaper: number; remainingSubmissions: number;
  /** Only while the AI is splitting the scan. */
  splitProgress: ScanSplitProgress | null }

// ---- v3: grading engines and the hosted agent ----
/** Which engine produced an AI call or a stored grading. */
export type GraderEngine = "direct" | "agent" | "fake" | "ollama";
/**
 * The teacher's choice in Settings → Grader; the practice grader is chosen by AI_MODE, not here. "ollama": a vision model
 * running on this computer through Ollama (no API key).
 */
export type GradingEngineChoice = "agent" | "direct" | "ollama";
export const GRADING_ENGINE_CHOICES = ["direct", "agent", "ollama"] as const satisfies readonly GradingEngineChoice[];
export type HostedAgentRole = "extract" | "grade" | "scan";
/** What Settings shows about the hosted agent for the API key in use. */
export interface HostedAgentStatusView {
  state: "not_set_up" | "setting_up" | "ready" | "error";
  /** Teacher-readable, only for "error". */
  error: string | null;
  /** When setup last succeeded ("ready") or failed ("error"); ms. */
  checkedAt: number | null;
}

// ---- v5: the AI model ----
/** The models a teacher can choose in Settings → AI model; the first is the default. */
export const AI_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"] as const;
export type AiModel = (typeof AI_MODELS)[number];
