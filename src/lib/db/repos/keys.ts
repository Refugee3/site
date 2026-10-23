import { now } from "@/lib/clock";
import { tx } from "@/lib/db/connection";
import { all, encodePatch, one, run, toBit, updateRow, type ColumnMap } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { AiUsage, AnswerKey, AnswerSource, AnswerType, Confidence, KeyItem, KeyStatus, NewKeyItem } from "@/lib/types";

interface AnswerKeyRow {
  assignment_id: string;
  status: KeyStatus;
  source_pdf_path: string | null;
  source_filename: string | null;
  source_sha256: string | null;
  source_page_count: number | null;
  document_kind: string | null;
  teacher_notes: string;
  ai_notes: string;
  revision: number;
  approved_revision: number | null;
  fingerprint: string | null;
  error_message: string | null;
  ai_model: string | null;
  usage_json: string | null;
  processing_started_at: number | null;
  processing_finished_at: number | null;
  updated_at: number;
}

interface KeyItemRow {
  id: string;
  assignment_id: string;
  position: number;
  label: string;
  group_label: string;
  prompt: string;
  answer_type: AnswerType;
  expected_answer: string;
  acceptable_answers_json: string;
  grading_criteria: string;
  points_centi: number;
  partial_credit: 0 | 1;
  page: number | null;
  answer_source: AnswerSource;
  ai_confidence: Confidence | null;
  ai_note: string;
}

function keyFromRow(row: AnswerKeyRow): AnswerKey {
  return {
    assignmentId: row.assignment_id,
    status: row.status,
    sourcePdfPath: row.source_pdf_path,
    sourceFilename: row.source_filename,
    sourceSha256: row.source_sha256,
    sourcePageCount: row.source_page_count,
    documentKind: row.document_kind,
    teacherNotes: row.teacher_notes,
    aiNotes: row.ai_notes,
    revision: row.revision,
    approvedRevision: row.approved_revision,
    fingerprint: row.fingerprint,
    errorMessage: row.error_message,
    aiModel: row.ai_model,
    usage: row.usage_json === null ? null : (JSON.parse(row.usage_json) as AiUsage),
    processingStartedAt: row.processing_started_at,
    processingFinishedAt: row.processing_finished_at,
    updatedAt: row.updated_at,
  };
}

function keyItemFromRow(row: KeyItemRow): KeyItem {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    position: row.position,
    label: row.label,
    groupLabel: row.group_label,
    prompt: row.prompt,
    answerType: row.answer_type,
    expectedAnswer: row.expected_answer,
    acceptableAnswers: JSON.parse(row.acceptable_answers_json) as string[],
    gradingCriteria: row.grading_criteria,
    pointsCenti: row.points_centi,
    partialCredit: row.partial_credit === 1,
    page: row.page,
    answerSource: row.answer_source,
    aiConfidence: row.ai_confidence,
    aiNote: row.ai_note,
  };
}

export function createEmptyKey(assignmentId: string): AnswerKey {
  const row = one<AnswerKeyRow>(
    "INSERT INTO answer_keys (assignment_id, updated_at) VALUES (?, ?) RETURNING *",
    assignmentId, now(),
  );
  return keyFromRow(row!);
}

export function getKey(assignmentId: string): AnswerKey | null {
  const row = one<AnswerKeyRow>("SELECT * FROM answer_keys WHERE assignment_id = ?", assignmentId);
  return row ? keyFromRow(row) : null;
}

type KeyPatch = Omit<AnswerKey, "assignmentId" | "updatedAt">;

const KEY_COLUMNS: ColumnMap<KeyPatch> = {
  status: "status",
  sourcePdfPath: "source_pdf_path",
  sourceFilename: "source_filename",
  sourceSha256: "source_sha256",
  sourcePageCount: "source_page_count",
  documentKind: "document_kind",
  teacherNotes: "teacher_notes",
  aiNotes: "ai_notes",
  revision: "revision",
  approvedRevision: "approved_revision",
  fingerprint: "fingerprint",
  errorMessage: "error_message",
  aiModel: "ai_model",
  usage: ["usage_json", (usage) => (usage === null ? null : JSON.stringify(usage))],
  processingStartedAt: "processing_started_at",
  processingFinishedAt: "processing_finished_at",
};

/** Throws AppError("not_found") when the assignment has no key row. */
export function updateKey(assignmentId: string, patch: Partial<KeyPatch>): AnswerKey {
  const row = updateRow<AnswerKeyRow>("answer_keys", { assignment_id: assignmentId }, encodePatch(patch, KEY_COLUMNS));
  if (!row) throw new AppError("not_found", "Answer key not found.");
  return keyFromRow(row);
}

export function listKeyItems(assignmentId: string): KeyItem[] {
  return all<KeyItemRow>("SELECT * FROM key_items WHERE assignment_id = ? ORDER BY position", assignmentId)
    .map(keyItemFromRow);
}

function itemValues(item: NewKeyItem, position: number) {
  return {
    position,
    label: item.label,
    group_label: item.groupLabel,
    prompt: item.prompt,
    answer_type: item.answerType,
    expected_answer: item.expectedAnswer,
    acceptable_answers_json: JSON.stringify(item.acceptableAnswers),
    grading_criteria: item.gradingCriteria,
    points_centi: item.pointsCenti,
    partial_credit: toBit(item.partialCredit),
    page: item.page,
    answer_source: item.answerSource,
    ai_confidence: item.aiConfidence,
    ai_note: item.aiNote,
  };
}

function insertKeyItem(assignmentId: string, item: NewKeyItem, position: number): void {
  run(
    `INSERT INTO key_items (id, assignment_id, position, label, group_label, prompt, answer_type, expected_answer,
       acceptable_answers_json, grading_criteria, points_centi, partial_credit, page, answer_source, ai_confidence, ai_note)
     VALUES (@id, @assignment_id, @position, @label, @group_label, @prompt, @answer_type, @expected_answer,
       @acceptable_answers_json, @grading_criteria, @points_centi, @partial_credit, @page, @answer_source, @ai_confidence, @ai_note)`,
    { id: newId(), assignment_id: assignmentId, ...itemValues(item, position) },
  );
}

function updateKeyItem(id: string, item: NewKeyItem, position: number): void {
  run(
    `UPDATE key_items SET position = @position, label = @label, group_label = @group_label, prompt = @prompt,
       answer_type = @answer_type, expected_answer = @expected_answer, acceptable_answers_json = @acceptable_answers_json,
       grading_criteria = @grading_criteria, points_centi = @points_centi, partial_credit = @partial_credit, page = @page,
       answer_source = @answer_source, ai_confidence = @ai_confidence, ai_note = @ai_note
     WHERE id = @id`,
    { id, ...itemValues(item, position) },
  );
}

/** Deletes every item (and, by cascade, their judgments and overrides) and inserts `items` with new ids. */
export function replaceKeyItems(assignmentId: string, items: NewKeyItem[]): KeyItem[] {
  return tx(() => {
    run("DELETE FROM key_items WHERE assignment_id = ?", assignmentId);
    items.forEach((item, position) => insertKeyItem(assignmentId, item, position));
    return listKeyItems(assignmentId);
  });
}

/**
 * Saves the edited item list: rows with a known id are updated in place (keeping judgments and overrides),
 * other rows are inserted, and items missing from the list are deleted. Position is the array index.
 * An id that does not belong to this assignment (or repeats) counts as null.
 */
export function upsertKeyItems(assignmentId: string, items: Array<NewKeyItem & { id: string | null }>): KeyItem[] {
  return tx(() => {
    const existingIds = new Set(listKeyItems(assignmentId).map((item) => item.id));
    const keptIds = new Set<string>();
    const rows = items.map(({ id, ...item }) => {
      const keptId = id !== null && existingIds.has(id) && !keptIds.has(id) ? id : null;
      if (keptId) keptIds.add(keptId);
      return { id: keptId, item };
    });
    for (const id of existingIds) {
      if (!keptIds.has(id)) run("DELETE FROM key_items WHERE id = ?", id);
    }
    rows.forEach(({ id, item }, position) => {
      if (id) updateKeyItem(id, item, position);
      else insertKeyItem(assignmentId, item, position);
    });
    return listKeyItems(assignmentId);
  });
}

/** Assignment ids whose key is 'processing' but has no queued or running extract_key job (boot recovery). */
export function listProcessingKeysWithoutJob(): string[] {
  return all<{ assignment_id: string }>(
    `SELECT k.assignment_id FROM answer_keys k
     WHERE k.status = 'processing'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'extract_key' AND j.target_id = k.assignment_id
                       AND j.status IN ('queued', 'running'))
     ORDER BY k.updated_at`,
  ).map((row) => row.assignment_id);
}

/** How long the last `limit` key readings took (from processing to the stored reading), newest first, over every assignment. */
export function recentExtractionDurations(limit: number): number[] {
  return all<{ ms: number }>(
    `SELECT processing_finished_at - processing_started_at AS ms FROM answer_keys
     WHERE processing_started_at IS NOT NULL AND processing_finished_at IS NOT NULL AND processing_finished_at >= processing_started_at
     ORDER BY processing_finished_at DESC LIMIT ?`,
    limit,
  ).map((row) => row.ms);
}
