import { guidanceFingerprint, renderGuidance } from "@/lib/ai/prompts";
import { listKeyItems } from "@/lib/db/repos/keys";
import { listLessons } from "@/lib/db/repos/lessons";
import { getGradingPreferences } from "@/lib/db/repos/teachers";
import { selectGuidanceLessons, toGuidanceLesson } from "@/lib/grading/lessons";
import type { Assignment, GradingGuidance, KeyItem, Lesson, LessonNotSentReason, Submission } from "@/lib/types";

// What the grader is told besides the key: the teacher's preferences and the lessons from their corrections.

export interface AssignmentGuidance {
  guidance: GradingGuidance;
  /** guidanceFingerprint of the rendered guidance ("" when there is none), as stored with each grading. */
  fingerprint: string;
  sentIds: string[];
  notSent: Record<string, LessonNotSentReason>;
}

/** The guidance a grading of this assignment would be sent now. Pass `items` when they are already loaded. */
export function loadGuidance(a: Pick<Assignment, "id" | "teacherId">, items: KeyItem[] = listKeyItems(a.id)): AssignmentGuidance {
  const lessons = listLessons(a.id);
  const { sentIds, notSent } = selectGuidanceLessons(lessons, new Set(items.map((item) => item.id)));
  const byId = new Map<string, Lesson>(lessons.map((lesson) => [lesson.id, lesson]));
  const guidance: GradingGuidance = {
    preferences: getGradingPreferences(a.teacherId),
    lessons: sentIds.map((id) => toGuidanceLesson(byId.get(id)!)),
  };
  return { guidance, fingerprint: guidanceFingerprint(renderGuidance(guidance, items)), sentIds, notSent };
}

/**
 * Graded, not reviewed yet, graded against the current key, but with other guidance than `fingerprint`
 * (the same predicate as listGuidanceStaleIds; a paper graded before guidance existed counts as "").
 */
export function isGuidanceStale(s: Submission, keyRevision: number, fingerprint: string): boolean {
  return (s.status === "graded" || s.status === "needs_review") && s.reviewedAt === null && s.gradedKeyRevision === keyRevision
    && (s.gradedGuidanceFp ?? "") !== fingerprint;
}
