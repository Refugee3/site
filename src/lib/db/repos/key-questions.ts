import { now } from "@/lib/clock";
import { tx } from "@/lib/db/connection";
import { all, one, run } from "@/lib/db/sql";
import { newId } from "@/lib/ids";
import type { KeyQuestion, KeyQuestionKind, KeyQuestionStatus, NewKeyQuestion } from "@/lib/types";

interface KeyQuestionRow {
  id: string;
  assignment_id: string;
  position: number;
  kind: KeyQuestionKind;
  item_label: string | null;
  question: string;
  suggested_answer: string | null;
  choices_json: string;
  status: KeyQuestionStatus;
  answer: string | null;
  answered_at: number | null;
  created_at: number;
  updated_at: number;
}

function questionFromRow(row: KeyQuestionRow): KeyQuestion {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    position: row.position,
    kind: row.kind,
    itemLabel: row.item_label,
    question: row.question,
    suggestedAnswer: row.suggested_answer,
    choices: JSON.parse(row.choices_json) as string[],
    status: row.status,
    answer: row.answer,
    answeredAt: row.answered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** In the order the AI asked them. */
export function listKeyQuestions(assignmentId: string): KeyQuestion[] {
  return all<KeyQuestionRow>("SELECT * FROM key_questions WHERE assignment_id = ? ORDER BY position", assignmentId).map(questionFromRow);
}

/** Deletes the assignment's questions and stores `questions` (a new reading of the key), all pending. */
export function replaceKeyQuestions(assignmentId: string, questions: NewKeyQuestion[]): KeyQuestion[] {
  return tx(() => {
    deleteKeyQuestions(assignmentId);
    const at = now();
    questions.forEach((q, position) => {
      run(
        `INSERT INTO key_questions (id, assignment_id, position, kind, item_label, question, suggested_answer, choices_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), assignmentId, position, q.kind, q.itemLabel, q.question, q.suggestedAnswer, JSON.stringify(q.choices), at, at,
      );
    });
    return listKeyQuestions(assignmentId);
  });
}

export function deleteKeyQuestions(assignmentId: string): void {
  run("DELETE FROM key_questions WHERE assignment_id = ?", assignmentId);
}

/** Records the teacher's answer (status answered) or a skip (answer null). Returns false for an unknown question. */
export function recordKeyQuestionAnswer(assignmentId: string, id: string, answer: string | null): boolean {
  const at = now();
  return run(
    `UPDATE key_questions SET status = ?, answer = ?, answered_at = ?, updated_at = ? WHERE id = ? AND assignment_id = ?`,
    answer === null ? "skipped" : "answered", answer, at, at, id, assignmentId,
  ) === 1;
}

/** Marks every still-pending question skipped (the teacher approved the key without answering them). */
export function skipPendingKeyQuestions(assignmentId: string): number {
  const at = now();
  return run(
    "UPDATE key_questions SET status = 'skipped', answered_at = ?, updated_at = ? WHERE assignment_id = ? AND status = 'pending'",
    at, at, assignmentId,
  );
}

/** A cheap fingerprint of the assignment's questions, for live change detection. */
export function keyQuestionsStamp(assignmentId: string): string {
  const row = one<{ n: number; latest: number | null }>(
    "SELECT count(*) AS n, max(updated_at) AS latest FROM key_questions WHERE assignment_id = ?",
    assignmentId,
  );
  return `${row?.n ?? 0}:${row?.latest ?? 0}`;
}
