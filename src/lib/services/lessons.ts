import { tx } from "@/lib/db/connection";
import {
  deleteLesson as deleteLessonRow, deleteLessonFor, getLesson, getLessonFor, setLessonActiveRow, updateLesson, upsertLesson,
} from "@/lib/db/repos/lessons";
import { getItem } from "@/lib/db/repos/submissions";
import { getGradingPreferences, setGradingPreferences } from "@/lib/db/repos/teachers";
import { AppError } from "@/lib/errors";
import { intendedJudgment } from "@/lib/grading/lessons";
import { charLength, truncateChars } from "@/lib/grading/text";
import { MAX_GRADING_PREFERENCES } from "@/lib/services/settings";
import type { Assignment, KeyItem, Lesson, Submission, Teacher } from "@/lib/types";

// A lesson is the teacher's correction of one item on one paper, kept so later gradings can follow it.

export const MAX_LESSON_REASON = 1000;
/** The lessons table's limits on its snapshots. */
const SNAPSHOT_LIMITS = { studentAnswer: 2000, feedback: 2000, whatStudentDid: 1000 } as const;

/**
 * Brings the item's lesson in line with its overrides; call it inside the transaction that saved them.
 * Any override keeps a lesson; clearing all three deletes it. The AI's reading (answer and judgment) is the one
 * the lesson first recorded, never recomputed: after a regrade the AI may agree with the teacher, and the lesson
 * would stop teaching the mistake it corrects. The teacher's side follows every save, ruled against that reading.
 * An answer the AI never read (a paper graded by hand) keeps no lesson: there is no mistake to learn from, and the
 * grader would never be sent it. A string `reason` is stored (trimmed); null or undefined keeps the stored reason.
 */
export function syncLessonForItem(s: Submission, a: Assignment, item: KeyItem, reason: string | null | undefined): void {
  const row = getItem(s.id, item.id);
  if (!row || (row.overrideCenti === null && row.overrideFeedback === null && row.overrideWhatStudentDid === null)) {
    deleteLessonFor(s.id, item.id);
    return;
  }
  const stored = getLessonFor(s.id, item.id);
  const reading = stored && stored.aiAttempt !== null && stored.aiCorrectness !== null
    ? { studentAnswer: stored.studentAnswer, attempt: stored.aiAttempt, correctness: stored.aiCorrectness }
    : row.judgment;
  if (!reading) {
    deleteLessonFor(s.id, item.id);
    return;
  }
  const ai = { attempt: reading.attempt, correctness: reading.correctness };
  const teacher = row.overrideCenti !== null ? intendedJudgment({ targetCenti: row.overrideCenti, item, mode: a, ai }) : ai;
  upsertLesson({
    assignmentId: a.id,
    submissionId: s.id,
    itemId: item.id,
    studentAnswer: truncateChars(reading.studentAnswer, SNAPSHOT_LIMITS.studentAnswer),
    aiAttempt: ai.attempt,
    aiCorrectness: ai.correctness,
    teacherAttempt: teacher.attempt,
    teacherCorrectness: teacher.correctness,
    overrideCenti: row.overrideCenti,
    feedback: clipOrNull(row.overrideFeedback, SNAPSHOT_LIMITS.feedback),
    whatStudentDid: clipOrNull(row.overrideWhatStudentDid, SNAPSHOT_LIMITS.whatStudentDid),
    ...(typeof reason === "string" ? { reason: reason.trim() } : {}),
  });
}

function clipOrNull(text: string | null, max: number): string | null {
  return text === null ? null : truncateChars(text, max);
}

/** Trimmed; throws a `reason` field error when it is longer than the lessons table allows. */
export function readLessonReason(reason: string): string {
  const trimmed = reason.trim();
  if (charLength(trimmed) > MAX_LESSON_REASON) {
    const message = `Use at most ${MAX_LESSON_REASON} characters.`;
    throw new AppError("validation", message, { fieldErrors: { reason: [message] } });
  }
  return trimmed;
}

export function updateLessonReason(lesson: Lesson, reason: string): Lesson {
  return updateLesson(lesson.id, { reason: readLessonReason(reason) });
}

/**
 * A lesson that is off stays on the Lessons tab but is not sent to the grader. Its place among the lessons
 * (by last content change) stays, so turning it off and on again leaves the guidance exactly as it was.
 */
export function setLessonActive(lesson: Lesson, active: boolean): Lesson {
  return setLessonActiveRow(lesson.id, active);
}

/**
 * The grader stops using it; the overrides on the paper stay as they are. Only a lesson whose paper was deleted is
 * deleted: one whose paper still exists is turned off instead, because the paper keeps the corrections it came from
 * and the next save of that question would bring a deleted lesson back (a lesson that is off stays off). Returns
 * whether it was deleted.
 */
export function deleteLesson(lesson: Lesson): { deleted: boolean } {
  return tx(() => {
    const current = getLesson(lesson.id);
    if (current && current.submissionId !== null) {
      setLessonActiveRow(current.id, false);
      return { deleted: false };
    }
    deleteLessonRow(lesson.id);
    return { deleted: true };
  });
}

/**
 * Appends the lesson's reason to the teacher's grading preferences as a "- <reason>" line (line breaks in
 * the reason become spaces, so it stays one line). Nothing changes when that line is already there.
 */
export function addLessonToPreferences(teacher: Teacher, lesson: Lesson): { added: boolean } {
  const reason = lesson.reason.trim().replace(/\s*\n\s*/g, " ");
  if (reason === "") {
    const message = "Write a reason first.";
    throw new AppError("validation", message, { fieldErrors: { reason: [message] } });
  }
  const line = `- ${reason}`;
  return tx(() => {
    const preferences = getGradingPreferences(teacher.id).trimEnd();
    if (preferences.split("\n").some((existing) => existing.trim() === line)) return { added: false };
    const next = preferences === "" ? line : `${preferences}\n${line}`;
    if (charLength(next) > MAX_GRADING_PREFERENCES) {
      const message = `Your grading preferences are full (${MAX_GRADING_PREFERENCES} characters). Shorten them in Settings first.`;
      throw new AppError("validation", message);
    }
    setGradingPreferences(teacher.id, next);
    return { added: true };
  });
}
