import { guidanceFingerprint, renderGuidance } from "@/lib/ai/prompts";
import { listKeyItems } from "@/lib/db/repos/keys";
import { listLessons } from "@/lib/db/repos/lessons";
import { getGradingPreferences } from "@/lib/db/repos/teachers";
import { selectGuidanceLessons } from "@/lib/grading/lessons";
import type { Assignment, GradingGuidance, KeyItem, LessonNotSentReason, Submission, SubmissionItem } from "@/lib/types";

// What the grader is told besides the key: the teacher's preferences and the lessons from their corrections.

export interface AssignmentGuidance {
  guidance: GradingGuidance;
  /**
   * guidanceFingerprint of the guidance rendered with the items in id order ("" when there is none), as stored with
   * each grading: reordering the key's items changes the refs the grader is sent, but not the guidance itself.
   */
  fingerprint: string;
  sentIds: string[];
  notSent: Record<string, LessonNotSentReason>;
}

/** The guidance a grading of this assignment would be sent now. Pass `items` when they are already loaded. */
export function loadGuidance(
  a: Pick<Assignment, "id" | "teacherId" | "gradingMode" | "accuracyWeight">,
  items: KeyItem[] = listKeyItems(a.id),
): AssignmentGuidance {
  const { sentIds, lessons, notSent } = selectGuidanceLessons(listLessons(a.id), items, a);
  const guidance: GradingGuidance = { preferences: getGradingPreferences(a.teacherId), lessons };
  return { guidance, fingerprint: guidanceFingerprint(renderGuidance(guidance, [...items].sort(byId))), sentIds, notSent };
}

/** Locale-independent, the same as SQLite's ORDER BY id for our ASCII ids. */
function byId(a: KeyItem, b: KeyItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Graded, not reviewed yet, not corrected by the teacher, graded against the current key, but with other guidance
 * than `fingerprint` (the same predicate as listGuidanceStaleIds; a paper graded before guidance existed counts as "").
 * A paper the teacher corrected was checked by them (and taught the newest lessons), so it is left alone; it can
 * still be regraded on its own.
 */
export function isGuidanceStale(s: Submission, keyRevision: number, fingerprint: string, items: SubmissionItem[]): boolean {
  return (s.status === "graded" || s.status === "needs_review") && s.reviewedAt === null && s.gradedKeyRevision === keyRevision
    && (s.gradedGuidanceFp ?? "") !== fingerprint && !hasTeacherCorrections(s, items);
}

/** Whether the teacher overrode the paper's total or any item's points, feedback or "what you did" note. */
export function hasTeacherCorrections(s: Pick<Submission, "totalOverrideCenti">, items: SubmissionItem[]): boolean {
  return s.totalOverrideCenti !== null
    || items.some((r) => r.overrideCenti !== null || r.overrideFeedback !== null || r.overrideWhatStudentDid !== null);
}
