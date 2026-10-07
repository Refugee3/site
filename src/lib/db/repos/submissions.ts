import { now } from "@/lib/clock";
import { tx } from "@/lib/db/connection";
import { getAssignment } from "@/lib/db/repos/assignments";
import { all, encodePatch, isUniqueViolation, one, run, toBit, updateRow, type ColumnMap } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import { statusFromFlags } from "@/lib/flags";
import {
  FLAG_CODES,
  SUBMISSION_STATUSES,
  type AiUsage, type Assignment, type Attempt, type Confidence, type Correctness, type DocumentMatch, type FlagCode,
  type ItemJudgment, type ItemReviewReason, type Legibility, type StatusCounts, type Submission, type SubmissionItem,
  type SubmissionStatus,
} from "@/lib/types";

export type NewSubmission = Pick<Submission, "id" | "assignmentId" | "source" | "receiptToken" | "pdfPath" | "originalFilename"
  | "contentSha256" | "byteSize" | "pageCount"> & Partial<Pick<Submission, "clientUploadId">>;

export interface GradingWrite {
  submissionId: string;
  generation: number;
  keyRevision: number;
  items: Array<{ itemId: string; judgment: ItemJudgment | null }>;
  fields: Pick<Submission, "aiName" | "aiNameConfidence" | "aiSectionRaw" | "aiSectionMatch" | "studentName" | "nameSource" | "nameKey"
    | "nameSortKey" | "sectionId" | "sectionKey" | "sectionSource" | "documentMatch" | "flags" | "status" | "teacherSummary"
    | "integrityNote" | "unmatchedWork" | "aiModel" | "usage"> & { overallFeedback: string; aiOutputJson: string | null };
}

interface SubmissionRow {
  id: string;
  assignment_id: string;
  source: "student" | "teacher";
  receipt_token: string;
  pdf_path: string;
  original_filename: string;
  content_sha256: string;
  client_upload_id: string | null;
  byte_size: number;
  page_count: number;
  status: SubmissionStatus;
  status_note: string | null;
  grading_generation: number;
  graded_key_revision: number | null;
  ai_name: string | null;
  ai_name_confidence: Confidence | null;
  ai_section_raw: string | null;
  ai_section_match: string | null;
  student_name: string | null;
  name_source: "ai" | "teacher" | null;
  name_key: string | null;
  name_sort_key: string;
  section_id: string | null;
  section_key: string | null;
  section_source: "ai" | "teacher" | null;
  document_match: DocumentMatch | null;
  flags_json: string;
  overall_feedback: string;
  overall_feedback_edited: 0 | 1;
  teacher_summary: string;
  integrity_note: string;
  unmatched_work: string;
  total_override_centi: number | null;
  score_earned_centi: number | null;
  score_max_centi: number | null;
  completion_centi: number | null;
  accuracy_centi: number | null;
  ai_model: string | null;
  usage_json: string | null;
  ai_output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  graded_at: number | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SubmissionItemRow {
  submission_id: string;
  item_id: string;
  attempt: Attempt | null;
  correctness: Correctness | null;
  legibility: Legibility | null;
  confidence: Confidence | null;
  review_reason: ItemReviewReason | null;
  student_answer: string;
  pages_json: string;
  what_student_did: string;
  feedback: string;
  teacher_note: string;
  override_centi: number | null;
  override_feedback: string | null;
  override_what_student_did: string | null;
  updated_at: number;
}

function usageToJson(usage: AiUsage | null): string | null {
  return usage === null ? null : JSON.stringify(usage);
}

function submissionFromRow(row: SubmissionRow): Submission {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    source: row.source,
    receiptToken: row.receipt_token,
    pdfPath: row.pdf_path,
    originalFilename: row.original_filename,
    contentSha256: row.content_sha256,
    clientUploadId: row.client_upload_id,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    status: row.status,
    statusNote: row.status_note,
    gradingGeneration: row.grading_generation,
    gradedKeyRevision: row.graded_key_revision,
    aiName: row.ai_name,
    aiNameConfidence: row.ai_name_confidence,
    aiSectionRaw: row.ai_section_raw,
    aiSectionMatch: row.ai_section_match,
    studentName: row.student_name,
    nameSource: row.name_source,
    nameKey: row.name_key,
    nameSortKey: row.name_sort_key,
    sectionId: row.section_id,
    sectionKey: row.section_key,
    sectionSource: row.section_source,
    documentMatch: row.document_match,
    flags: JSON.parse(row.flags_json) as FlagCode[],
    overallFeedback: row.overall_feedback,
    overallFeedbackEdited: row.overall_feedback_edited === 1,
    teacherSummary: row.teacher_summary,
    integrityNote: row.integrity_note,
    unmatchedWork: row.unmatched_work,
    totalOverrideCenti: row.total_override_centi,
    scoreEarnedCenti: row.score_earned_centi,
    scoreMaxCenti: row.score_max_centi,
    completionCenti: row.completion_centi,
    accuracyCenti: row.accuracy_centi,
    aiModel: row.ai_model,
    usage: row.usage_json === null ? null : (JSON.parse(row.usage_json) as AiUsage),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    gradedAt: row.graded_at,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function judgmentFromRow(row: SubmissionItemRow): ItemJudgment | null {
  // The AI columns are written together: all null means "no judgment".
  if (row.attempt === null || row.correctness === null || row.legibility === null || row.confidence === null
    || row.review_reason === null) {
    return null;
  }
  return {
    attempt: row.attempt,
    correctness: row.correctness,
    legibility: row.legibility,
    confidence: row.confidence,
    reviewReason: row.review_reason,
    studentAnswer: row.student_answer,
    pages: JSON.parse(row.pages_json) as number[],
    whatStudentDid: row.what_student_did,
    feedback: row.feedback,
    teacherNote: row.teacher_note,
  };
}

function itemFromRow(row: SubmissionItemRow): SubmissionItem {
  return {
    submissionId: row.submission_id,
    itemId: row.item_id,
    judgment: judgmentFromRow(row),
    overrideCenti: row.override_centi,
    overrideFeedback: row.override_feedback,
    overrideWhatStudentDid: row.override_what_student_did,
    updatedAt: row.updated_at,
  };
}

/** Inserts a queued submission; throws AppError("duplicate") when the same content is already in this assignment. */
export function insertSubmission(s: NewSubmission): Submission {
  const at = now();
  try {
    const row = one<SubmissionRow>(
      `INSERT INTO submissions (id, assignment_id, source, receipt_token, pdf_path, original_filename, content_sha256,
         client_upload_id, byte_size, page_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      s.id, s.assignmentId, s.source, s.receiptToken, s.pdfPath, s.originalFilename, s.contentSha256,
      s.clientUploadId ?? null, s.byteSize, s.pageCount, at, at,
    );
    return submissionFromRow(row!);
  } catch (error) {
    if (isUniqueViolation(error, "submissions.content_sha256")) {
      throw new AppError("duplicate", "This exact file was already submitted for this assignment.");
    }
    throw error;
  }
}

export function getSubmission(id: string): Submission | null {
  const row = one<SubmissionRow>("SELECT * FROM submissions WHERE id = ?", id);
  return row ? submissionFromRow(row) : null;
}

export function getSubmissionByReceipt(token: string): Submission | null {
  const row = one<SubmissionRow>("SELECT * FROM submissions WHERE receipt_token = ?", token);
  return row ? submissionFromRow(row) : null;
}

export function getSubmissionForTeacher(id: string, teacherId: string): { submission: Submission; assignment: Assignment } | null {
  const row = one<SubmissionRow>(
    `SELECT s.* FROM submissions s JOIN assignments a ON a.id = s.assignment_id
     WHERE s.id = ? AND a.teacher_id = ?`,
    id, teacherId,
  );
  if (!row) return null;
  const assignment = getAssignment(row.assignment_id);
  return assignment ? { submission: submissionFromRow(row), assignment } : null;
}

export function findBySha(assignmentId: string, sha: string): Submission | null {
  const row = one<SubmissionRow>("SELECT * FROM submissions WHERE assignment_id = ? AND content_sha256 = ?", assignmentId, sha);
  return row ? submissionFromRow(row) : null;
}

export function countSubmissions(assignmentId: string): number {
  return one<{ n: number }>("SELECT count(*) AS n FROM submissions WHERE assignment_id = ?", assignmentId)!.n;
}

/** Oldest first. */
export function listSubmissions(assignmentId: string): Submission[] {
  return all<SubmissionRow>("SELECT * FROM submissions WHERE assignment_id = ? ORDER BY created_at, rowid", assignmentId)
    .map(submissionFromRow);
}

export function countByStatus(assignmentId: string): StatusCounts {
  const counts = Object.fromEntries(SUBMISSION_STATUSES.map((status) => [status, 0])) as StatusCounts;
  counts.total = 0;
  const rows = all<{ status: SubmissionStatus; n: number }>(
    "SELECT status, count(*) AS n FROM submissions WHERE assignment_id = ? GROUP BY status",
    assignmentId,
  );
  for (const { status, n } of rows) {
    counts[status] = n;
    counts.total += n;
  }
  return counts;
}

/** queued (or grading left by a crashed run of the same job) → grading, only for the current generation. */
export function startGrading(id: string, generation: number): boolean {
  return run(
    `UPDATE submissions SET status = 'grading', updated_at = ?
     WHERE id = ? AND grading_generation = ? AND status IN ('queued', 'grading')`,
    now(), id, generation,
  ) > 0;
}

function sectionBelongsTo(sectionId: string, assignmentId: string): boolean {
  return one("SELECT 1 FROM sections WHERE id = ? AND assignment_id = ?", sectionId, assignmentId) !== undefined;
}

function hasSections(assignmentId: string): boolean {
  return one("SELECT 1 FROM sections WHERE assignment_id = ?", assignmentId) !== undefined;
}

/**
 * The section fields to store when the result names a section that is gone (the teacher edited the
 * sections after it was computed): the paper is unsectioned and, while sections exist, flagged for review.
 */
function withoutVanishedSection(f: GradingWrite["fields"], assignmentId: string): Pick<GradingWrite["fields"], "sectionId" | "sectionSource" | "flags" | "status"> {
  if (f.sectionId === null || sectionBelongsTo(f.sectionId, assignmentId)) {
    return { sectionId: f.sectionId, sectionSource: f.sectionSource, flags: f.flags, status: f.status };
  }
  const present = new Set<FlagCode>(f.flags.filter((flag) => flag !== "section_inferred"));
  if (hasSections(assignmentId)) present.add("section_unmatched");
  const flags = FLAG_CODES.filter((code) => present.has(code));
  return { sectionId: null, sectionSource: null, flags, status: statusFromFlags(flags, null) };
}

function upsertJudgment(submissionId: string, itemId: string, judgment: ItemJudgment | null, at: number): void {
  run(
    `INSERT INTO submission_items (submission_id, item_id, attempt, correctness, legibility, confidence, review_reason,
       student_answer, pages_json, what_student_did, feedback, teacher_note, updated_at)
     VALUES (@submission_id, @item_id, @attempt, @correctness, @legibility, @confidence, @review_reason,
       @student_answer, @pages_json, @what_student_did, @feedback, @teacher_note, @updated_at)
     ON CONFLICT (submission_id, item_id) DO UPDATE SET
       attempt = excluded.attempt, correctness = excluded.correctness, legibility = excluded.legibility,
       confidence = excluded.confidence, review_reason = excluded.review_reason, student_answer = excluded.student_answer,
       pages_json = excluded.pages_json, what_student_did = excluded.what_student_did, feedback = excluded.feedback,
       teacher_note = excluded.teacher_note, updated_at = excluded.updated_at`,
    {
      submission_id: submissionId,
      item_id: itemId,
      attempt: judgment?.attempt ?? null,
      correctness: judgment?.correctness ?? null,
      legibility: judgment?.legibility ?? null,
      confidence: judgment?.confidence ?? null,
      review_reason: judgment?.reviewReason ?? null,
      student_answer: judgment?.studentAnswer ?? "",
      pages_json: JSON.stringify(judgment?.pages ?? []),
      what_student_did: judgment?.whatStudentDid ?? "",
      feedback: judgment?.feedback ?? "",
      teacher_note: judgment?.teacherNote ?? "",
      updated_at: at,
    },
  );
}

/**
 * Writes a grading result if the submission is still on `w.generation` (false → nothing written).
 * Upserts only the AI columns of each item, so teacher overrides survive; skips items no longer in the key.
 * An edited overall feedback is kept. Clears status_note, error_* and reviewed_at.
 */
export function saveGradingResult(w: GradingWrite): boolean {
  return tx(() => {
    const current = one<{ assignment_id: string; grading_generation: number }>(
      "SELECT assignment_id, grading_generation FROM submissions WHERE id = ?",
      w.submissionId,
    );
    if (!current || current.grading_generation !== w.generation) return false;

    const at = now();
    const f = w.fields;
    const section = withoutVanishedSection(f, current.assignment_id);
    run(
      `UPDATE submissions SET
         ai_name = @ai_name, ai_name_confidence = @ai_name_confidence, ai_section_raw = @ai_section_raw,
         ai_section_match = @ai_section_match, student_name = @student_name, name_source = @name_source,
         name_key = @name_key, name_sort_key = @name_sort_key, section_id = @section_id, section_key = @section_key,
         section_source = @section_source, document_match = @document_match, flags_json = @flags_json, status = @status,
         teacher_summary = @teacher_summary, integrity_note = @integrity_note, unmatched_work = @unmatched_work,
         ai_model = @ai_model, usage_json = @usage_json, ai_output_json = @ai_output_json,
         overall_feedback = CASE WHEN overall_feedback_edited = 1 THEN overall_feedback ELSE @overall_feedback END,
         graded_key_revision = @graded_key_revision, graded_at = @at, updated_at = @at,
         status_note = NULL, error_code = NULL, error_message = NULL, reviewed_at = NULL
       WHERE id = @id AND grading_generation = @generation`,
      {
        id: w.submissionId,
        generation: w.generation,
        at,
        ai_name: f.aiName,
        ai_name_confidence: f.aiNameConfidence,
        ai_section_raw: f.aiSectionRaw,
        ai_section_match: f.aiSectionMatch,
        student_name: f.studentName,
        name_source: f.nameSource,
        name_key: f.nameKey,
        name_sort_key: f.nameSortKey,
        section_id: section.sectionId,
        section_key: f.sectionKey,
        section_source: section.sectionSource,
        document_match: f.documentMatch,
        flags_json: JSON.stringify(section.flags),
        status: section.status,
        teacher_summary: f.teacherSummary,
        integrity_note: f.integrityNote,
        unmatched_work: f.unmatchedWork,
        ai_model: f.aiModel,
        usage_json: usageToJson(f.usage),
        ai_output_json: f.aiOutputJson,
        overall_feedback: f.overallFeedback,
        graded_key_revision: w.keyRevision,
      },
    );

    const keyItemIds = new Set(
      all<{ id: string }>("SELECT id FROM key_items WHERE assignment_id = ?", current.assignment_id).map((row) => row.id),
    );
    for (const { itemId, judgment } of w.items) {
      if (keyItemIds.has(itemId)) upsertJudgment(w.submissionId, itemId, judgment, at);
    }
    return true;
  });
}

/** grading → queued with a note for the teacher, only for the current generation. */
export function scheduleRetry(id: string, generation: number, note: string): boolean {
  return run(
    `UPDATE submissions SET status = 'queued', status_note = ?, updated_at = ?
     WHERE id = ? AND grading_generation = ? AND status = 'grading'`,
    note, now(), id, generation,
  ) > 0;
}

/** queued/grading → failed, only for the current generation. */
export function markFailed(id: string, generation: number, code: string, message: string): boolean {
  return run(
    `UPDATE submissions SET status = 'failed', error_code = ?, error_message = ?, status_note = NULL, updated_at = ?
     WHERE id = ? AND grading_generation = ? AND status IN ('queued', 'grading')`,
    code, message, now(), id, generation,
  ) > 0;
}

/** Starts a new grading generation (any running result for the old one is then discarded); returns it. */
export function requeueForRegrade(id: string): number {
  const row = one<{ grading_generation: number }>(
    `UPDATE submissions SET grading_generation = grading_generation + 1, status = 'queued', reviewed_at = NULL,
       error_code = NULL, error_message = NULL, status_note = NULL, updated_at = ?
     WHERE id = ? RETURNING grading_generation`,
    now(), id,
  );
  if (!row) throw new AppError("not_found", "Submission not found.");
  return row.grading_generation;
}

type SubmissionPatch = Pick<Submission, "status" | "statusNote" | "studentName" | "nameSource" | "nameKey" | "nameSortKey"
  | "sectionId" | "sectionSource" | "flags" | "overallFeedback" | "overallFeedbackEdited" | "totalOverrideCenti" | "scoreEarnedCenti"
  | "scoreMaxCenti" | "completionCenti" | "accuracyCenti" | "reviewedAt" | "errorCode" | "errorMessage">;

const SUBMISSION_COLUMNS: ColumnMap<SubmissionPatch> = {
  status: "status",
  statusNote: "status_note",
  studentName: "student_name",
  nameSource: "name_source",
  nameKey: "name_key",
  nameSortKey: "name_sort_key",
  sectionId: "section_id",
  sectionSource: "section_source",
  flags: ["flags_json", (flags) => JSON.stringify(flags)],
  overallFeedback: "overall_feedback",
  overallFeedbackEdited: ["overall_feedback_edited", toBit],
  totalOverrideCenti: "total_override_centi",
  scoreEarnedCenti: "score_earned_centi",
  scoreMaxCenti: "score_max_centi",
  completionCenti: "completion_centi",
  accuracyCenti: "accuracy_centi",
  reviewedAt: "reviewed_at",
  errorCode: "error_code",
  errorMessage: "error_message",
};

/** Throws AppError("not_found") when the submission does not exist. */
export function updateSubmission(id: string, patch: Partial<SubmissionPatch>): Submission {
  const row = updateRow<SubmissionRow>("submissions", { id }, encodePatch(patch, SUBMISSION_COLUMNS));
  if (!row) throw new AppError("not_found", "Submission not found.");
  return submissionFromRow(row);
}

/** Key-item order. */
export function listItems(submissionId: string): SubmissionItem[] {
  return all<SubmissionItemRow>(
    `SELECT si.* FROM submission_items si JOIN key_items ki ON ki.id = si.item_id
     WHERE si.submission_id = ? ORDER BY ki.position`,
    submissionId,
  ).map(itemFromRow);
}

/** Every submission's items, keyed by submission id (submissions without items are absent). */
export function listItemsForAssignment(assignmentId: string): Map<string, SubmissionItem[]> {
  const rows = all<SubmissionItemRow>(
    `SELECT si.* FROM submission_items si
       JOIN submissions s ON s.id = si.submission_id
       JOIN key_items ki ON ki.id = si.item_id
     WHERE s.assignment_id = ? ORDER BY si.submission_id, ki.position`,
    assignmentId,
  );
  const bySubmission = new Map<string, SubmissionItem[]>();
  for (const row of rows) {
    const items = bySubmission.get(row.submission_id) ?? [];
    items.push(itemFromRow(row));
    bySubmission.set(row.submission_id, items);
  }
  return bySubmission;
}

/** Sets the given override fields (undefined = unchanged), creating an unjudged row if needed. */
export function setItemOverride(
  submissionId: string,
  itemId: string,
  p: { overrideCenti?: number | null; overrideFeedback?: string | null; overrideWhatStudentDid?: string | null },
): void {
  tx(() => {
    run(
      `INSERT INTO submission_items (submission_id, item_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (submission_id, item_id) DO NOTHING`,
      submissionId, itemId, now(),
    );
    const values = encodePatch(p, {
      overrideCenti: "override_centi",
      overrideFeedback: "override_feedback",
      overrideWhatStudentDid: "override_what_student_did",
    });
    updateRow("submission_items", { submission_id: submissionId, item_id: itemId }, values);
  });
}

export function deleteSubmissionRow(id: string): void {
  run("DELETE FROM submissions WHERE id = ?", id);
}

/** Oldest first. */
export function listIdsByStatus(assignmentId: string, statuses: SubmissionStatus[]): string[] {
  return all<{ id: string }>(
    `SELECT id FROM submissions WHERE assignment_id = ? AND status IN (SELECT value FROM json_each(?))
     ORDER BY created_at, rowid`,
    assignmentId, JSON.stringify(statuses),
  ).map((row) => row.id);
}

/** Graded papers whose judgments predate key revision `revision`. */
export function listStaleIds(assignmentId: string, revision: number): string[] {
  return all<{ id: string }>(
    `SELECT id FROM submissions
     WHERE assignment_id = ? AND status IN ('graded', 'needs_review') AND graded_key_revision < ?
     ORDER BY created_at, rowid`,
    assignmentId, revision,
  ).map((row) => row.id);
}

/** Boot recovery: nothing can be grading before the worker starts. */
export function resetGradingToQueued(): number {
  return run("UPDATE submissions SET status = 'queued', updated_at = ? WHERE status = 'grading'", now());
}

/** Queued submissions with no queued or running grade job (boot recovery). */
export function listQueuedWithoutJob(): Array<{ id: string; assignmentId: string; source: "student" | "teacher" }> {
  return all<{ id: string; assignment_id: string; source: "student" | "teacher" }>(
    `SELECT s.id, s.assignment_id, s.source FROM submissions s
     WHERE s.status = 'queued'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'grade_submission' AND j.target_id = s.id
                       AND j.status IN ('queued', 'running'))
     ORDER BY s.created_at, s.rowid`,
  ).map((row) => ({ id: row.id, assignmentId: row.assignment_id, source: row.source }));
}
