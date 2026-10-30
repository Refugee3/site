import { now } from "@/lib/clock";
import { getAssignment } from "@/lib/db/repos/assignments";
import { all, encodePatch, one, run, toBit, updateRow, type ColumnMap } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { Assignment, Attempt, Correctness, Lesson } from "@/lib/types";

export type LessonSnapshot = Pick<Lesson, "studentAnswer" | "aiAttempt" | "aiCorrectness" | "teacherAttempt" | "teacherCorrectness"
  | "overrideCenti" | "feedback" | "whatStudentDid">;

interface LessonRow {
  id: string;
  assignment_id: string;
  item_id: string;
  submission_id: string | null;
  student_answer: string;
  ai_attempt: Attempt | null;
  ai_correctness: Correctness | null;
  teacher_attempt: Attempt | null;
  teacher_correctness: Correctness | null;
  override_centi: number | null;
  feedback: string | null;
  what_student_did: string | null;
  reason: string;
  active: 0 | 1;
  created_at: number;
  updated_at: number;
}

function lessonFromRow(row: LessonRow): Lesson {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    itemId: row.item_id,
    submissionId: row.submission_id,
    studentAnswer: row.student_answer,
    aiAttempt: row.ai_attempt,
    aiCorrectness: row.ai_correctness,
    teacherAttempt: row.teacher_attempt,
    teacherCorrectness: row.teacher_correctness,
    overrideCenti: row.override_centi,
    feedback: row.feedback,
    whatStudentDid: row.what_student_did,
    reason: row.reason,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates or refreshes the lesson for (submission, item). The teacher's side (teacher_*, override_centi, feedback,
 * what_student_did) is replaced; the AI's side (student_answer, ai_attempt, ai_correctness) is the first reading and
 * is kept once there is one, so a later regrade that agrees with the teacher never rewrites the mistake the lesson
 * teaches (a lesson without a reading, from manual grading, takes the first reading that comes). id, active and
 * created_at are kept. `reason` is set only when given (undefined keeps the stored one; a new lesson gets "").
 */
export function upsertLesson(l: { assignmentId: string; submissionId: string; itemId: string; reason?: string } & LessonSnapshot): Lesson {
  const row = one<LessonRow>(
    `INSERT INTO lessons (id, assignment_id, item_id, submission_id, student_answer, ai_attempt, ai_correctness, teacher_attempt,
       teacher_correctness, override_centi, feedback, what_student_did, reason, created_at, updated_at)
     VALUES (@id, @assignment_id, @item_id, @submission_id, @student_answer, @ai_attempt, @ai_correctness, @teacher_attempt,
       @teacher_correctness, @override_centi, @feedback, @what_student_did, @reason, @at, @at)
     ON CONFLICT (submission_id, item_id) DO UPDATE SET
       student_answer = CASE WHEN lessons.ai_attempt IS NULL THEN excluded.student_answer ELSE lessons.student_answer END,
       ai_correctness = CASE WHEN lessons.ai_attempt IS NULL THEN excluded.ai_correctness ELSE lessons.ai_correctness END,
       ai_attempt = CASE WHEN lessons.ai_attempt IS NULL THEN excluded.ai_attempt ELSE lessons.ai_attempt END,
       teacher_attempt = excluded.teacher_attempt, teacher_correctness = excluded.teacher_correctness,
       override_centi = excluded.override_centi, feedback = excluded.feedback, what_student_did = excluded.what_student_did,
       reason = CASE WHEN @set_reason THEN excluded.reason ELSE reason END,
       updated_at = excluded.updated_at
     RETURNING *`,
    {
      id: newId(),
      assignment_id: l.assignmentId,
      item_id: l.itemId,
      submission_id: l.submissionId,
      student_answer: l.studentAnswer,
      ai_attempt: l.aiAttempt,
      ai_correctness: l.aiCorrectness,
      teacher_attempt: l.teacherAttempt,
      teacher_correctness: l.teacherCorrectness,
      override_centi: l.overrideCenti,
      feedback: l.feedback,
      what_student_did: l.whatStudentDid,
      reason: l.reason ?? "",
      set_reason: l.reason === undefined ? 0 : 1,
      at: now(),
    },
  );
  return lessonFromRow(row!);
}

/** Deletes the lesson for (submission, item), if any; returns how many were deleted. */
export function deleteLessonFor(submissionId: string, itemId: string): number {
  return run("DELETE FROM lessons WHERE submission_id = ? AND item_id = ?", submissionId, itemId);
}

/** The lesson for (submission, item), if any. */
export function getLessonFor(submissionId: string, itemId: string): Lesson | null {
  const row = one<LessonRow>("SELECT * FROM lessons WHERE submission_id = ? AND item_id = ?", submissionId, itemId);
  return row ? lessonFromRow(row) : null;
}

export function getLesson(id: string): Lesson | null {
  const row = one<LessonRow>("SELECT * FROM lessons WHERE id = ?", id);
  return row ? lessonFromRow(row) : null;
}

export function getLessonForTeacher(id: string, teacherId: string): { lesson: Lesson; assignment: Assignment } | null {
  const row = one<LessonRow>(
    `SELECT l.* FROM lessons l JOIN assignments a ON a.id = l.assignment_id
     WHERE l.id = ? AND a.teacher_id = ?`,
    id, teacherId,
  );
  if (!row) return null;
  const assignment = getAssignment(row.assignment_id);
  return assignment ? { lesson: lessonFromRow(row), assignment } : null;
}

/** Newest first. */
export function listLessons(assignmentId: string): Lesson[] {
  return all<LessonRow>("SELECT * FROM lessons WHERE assignment_id = ? ORDER BY updated_at DESC, id", assignmentId)
    .map(lessonFromRow);
}

/** Newest first. */
export function listLessonsForSubmission(submissionId: string): Lesson[] {
  return all<LessonRow>("SELECT * FROM lessons WHERE submission_id = ? ORDER BY updated_at DESC, id", submissionId)
    .map(lessonFromRow);
}

type LessonPatch = Pick<Lesson, "reason" | "active">;

const LESSON_COLUMNS: ColumnMap<LessonPatch> = {
  reason: "reason",
  active: ["active", toBit],
};

/** Bumps updated_at (a content change). Throws AppError("not_found") when the lesson does not exist. */
export function updateLesson(id: string, patch: Partial<LessonPatch>): Lesson {
  const row = updateRow<LessonRow>("lessons", { id }, encodePatch(patch, LESSON_COLUMNS));
  if (!row) throw new AppError("not_found", "Lesson not found.");
  return lessonFromRow(row);
}

/**
 * Turns the lesson on or off without touching updated_at, which orders lessons as the time of their last
 * content change ("newest" for the grader): off and on again changes nothing the grader is sent.
 * Throws AppError("not_found") when the lesson does not exist.
 */
export function setLessonActiveRow(id: string, active: boolean): Lesson {
  const row = one<LessonRow>("UPDATE lessons SET active = ? WHERE id = ? RETURNING *", toBit(active), id);
  if (!row) throw new AppError("not_found", "Lesson not found.");
  return lessonFromRow(row);
}

export function deleteLesson(id: string): void {
  run("DELETE FROM lessons WHERE id = ?", id);
}
