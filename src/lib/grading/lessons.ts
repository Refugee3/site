import { accuracyQuarters, computeScore } from "@/lib/grading/scoring";
import { charLength, truncateChars } from "@/lib/grading/text";
import {
  type Assignment,
  type Attempt,
  ATTEMPTS,
  CORRECTNESS,
  type Correctness,
  type GuidanceLesson,
  type ItemJudgment,
  type KeyItem,
  type Lesson,
  type LessonNotSentReason,
  type SubmissionItem,
} from "@/lib/types";

// Lessons are the teacher's corrections, sent back to the grader as guidance on later papers.

export const GUIDANCE_LIMITS = { perItem: 5, totalChars: 12_000, studentAnswer: 400, reason: 1000, feedback: 300, whatStudentDid: 300 } as const;
// reason: 1000 = the stored limit, so the model always reads the teacher's whole reason (feedback/"what you did" are only wording examples).

/** Per-lesson overhead in the character budget: the tags and labels renderGuidance wraps around the texts. */
const LESSON_OVERHEAD_CHARS = 120;
/** The extra lines renderGuidance adds for points that no judgment gives exactly. */
const INEXACT_OVERHEAD_CHARS = 180;

type Pair = { attempt: Attempt; correctness: Correctness };
type ScoringMode = Pick<Assignment, "gradingMode" | "accuracyWeight">;

const GRADED_PAIRS: Pair[] = [
  { attempt: "none", correctness: "no_answer" },
  ...(["partially_correct", "major_error", "incorrect"] as const).map((correctness) => ({ attempt: "partial" as const, correctness })),
  ...(["correct", "minor_error", "partially_correct", "major_error", "incorrect"] as const)
    .map((correctness) => ({ attempt: "complete" as const, correctness })),
];
const BINARY_PAIRS: Pair[] = [
  { attempt: "complete", correctness: "correct" },
  { attempt: "complete", correctness: "incorrect" },
  { attempt: "none", correctness: "no_answer" },
];

/** The (attempt, correctness) whose computed points are nearest the teacher's, under the assignment's mode/weight and the item's points/partial credit. */
export function intendedJudgment(i: {
  targetCenti: number;
  item: KeyItem;
  mode: ScoringMode;
  ai: Pick<ItemJudgment, "attempt" | "correctness"> | null;
}): { attempt: Attempt; correctness: Correctness; exact: boolean } {
  const target = clampToItem(i.targetCenti, i.item);
  const { ai } = i;
  const candidates = i.item.answerType === "multiple_choice" || i.item.answerType === "true_false" ? BINARY_PAIRS : GRADED_PAIRS;
  const ranked = candidates.map((pair) => {
    const points = pointsFor(pair, i.item, i.mode);
    const rank = [
      Math.abs(points - target),
      ai && (pair.attempt !== ai.attempt || pair.correctness !== ai.correctness) ? 1 : 0,
      ai && pair.attempt !== ai.attempt ? 1 : 0,
      ai ? Math.abs(partialQuarters(pair.correctness) - partialQuarters(ai.correctness)) : 0,
      CORRECTNESS.indexOf(pair.correctness),
      ATTEMPTS.indexOf(pair.attempt),
    ];
    return { pair, points, rank };
  });
  const best = ranked.reduce((a, b) => (compareRanks(b.rank, a.rank) < 0 ? b : a));
  return { ...best.pair, exact: best.points === target };
}

/**
 * Whether the teacher's ruling scores exactly the points the teacher gave, under the assignment's current scoring;
 * null when the teacher kept the AI's points. A ruling that is not exact stands for points no judgment gives.
 */
export function rulingIsExact(
  l: Pick<Lesson, "overrideCenti" | "teacherAttempt" | "teacherCorrectness">,
  item: KeyItem,
  mode: ScoringMode,
): boolean | null {
  if (l.overrideCenti === null || l.teacherAttempt === null || l.teacherCorrectness === null) return null;
  return pointsFor({ attempt: l.teacherAttempt, correctness: l.teacherCorrectness }, item, mode) === clampToItem(l.overrideCenti, item);
}

function clampToItem(centi: number, item: KeyItem): number {
  return Math.min(Math.max(centi, 0), item.pointsCenti);
}

/** The item's computed points for a judgment, through the same scoring code that grades papers. */
function pointsFor(pair: Pair, item: KeyItem, mode: ScoringMode): number {
  const result: SubmissionItem = {
    submissionId: "", itemId: item.id, overrideCenti: null, overrideFeedback: null, overrideWhatStudentDid: null, updatedAt: 0,
    judgment: {
      ...pair, legibility: "clear", confidence: "high", reviewReason: "none", studentAnswer: "", pages: [], whatStudentDid: "",
      feedback: "", teacherNote: "",
    },
  };
  return computeScore([item], new Map([[item.id, result]]), mode, null).items[0].computedCenti ?? 0;
}

/** Partial-credit quarters (correct 4 … major error 1, else 0): how close two correctness values are. */
function partialQuarters(correctness: Correctness): number {
  return accuracyQuarters({ attempt: "complete", correctness }, true);
}

function compareRanks(a: number[], b: number[]): number {
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return 0;
}

/**
 * Whether a lesson teaches the grader anything: the AI read the answer, and the teacher either
 * explained, ruled differently, gave points no judgment gives exactly (`exact` false, see rulingIsExact),
 * or showed how they word notes. A teacher who only blanked a note (which hides it from the student)
 * taught nothing, and renderGuidance would print no line for it.
 */
export function isInformative(
  l: Pick<Lesson, "reason" | "aiAttempt" | "aiCorrectness" | "teacherAttempt" | "teacherCorrectness" | "feedback" | "whatStudentDid">
    & { exact?: boolean | null },
): boolean {
  return l.aiAttempt !== null && (
    l.reason.trim() !== ""
    || l.teacherAttempt !== l.aiAttempt
    || l.teacherCorrectness !== l.aiCorrectness
    || l.exact === false
    || (l.feedback ?? "").trim() !== ""
    || (l.whatStudentDid ?? "").trim() !== "");
}

/**
 * Which lessons go to the grader, deterministically: newest first, at most `perItem` per item, within
 * a total character budget. Every lesson left out gets the first reason that applies. `lessons` are the
 * sent ones as the grader receives them, in the order of `sentIds`.
 */
export function selectGuidanceLessons(
  lessons: Lesson[],
  items: KeyItem[],
  mode: ScoringMode,
): { sentIds: string[]; lessons: GuidanceLesson[]; notSent: Record<string, LessonNotSentReason> } {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const sorted = [...lessons].sort((a, b) => b.updatedAt - a.updatedAt || compareIds(a.id, b.id));
  const notSent: Record<string, LessonNotSentReason> = {};
  const perItem = new Map<string, number>();
  const sentIds: string[] = [];
  const sent: GuidanceLesson[] = [];
  let usedChars = 0;
  for (const lesson of sorted) {
    const item = itemById.get(lesson.itemId);
    const exact = item ? rulingIsExact(lesson, item, mode) : null;
    const reason = item ? exclusionReason(lesson, exact) : "unknown_item";
    if (reason) {
      notSent[lesson.id] = reason;
      continue;
    }
    const countForItem = (perItem.get(lesson.itemId) ?? 0) + 1;
    perItem.set(lesson.itemId, countForItem);
    const guidance = toGuidanceLesson(lesson, exact);
    const size = guidanceSize(guidance);
    if (countForItem > GUIDANCE_LIMITS.perItem || usedChars + size > GUIDANCE_LIMITS.totalChars) {
      notSent[lesson.id] = "limit";
      continue;
    }
    usedChars += size;
    sentIds.push(lesson.id);
    sent.push(guidance);
  }
  return { sentIds, lessons: sent, notSent };
}

/** Locale-independent order, the same as SQLite's ORDER BY id for our ASCII ids. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function exclusionReason(l: Lesson, exact: boolean | null): LessonNotSentReason | null {
  if (!l.active) return "inactive";
  if (l.aiAttempt === null) return "no_reading";
  if (isUnexplainedReadingFix(l)) return "reading_fix";
  if (!isInformative({ ...l, exact })) return "agrees";
  return null;
}

/**
 * The AI could not read the answer (it saw a blank, wrote "[illegible]", or could not judge it) and the
 * teacher credited an attempt without saying why: the teacher judged work the grader never saw, so the
 * lesson says nothing about the answer as the grader read it (a later blank must not be ruled the same way).
 */
function isUnexplainedReadingFix(l: Lesson): boolean {
  const unread = l.aiCorrectness === "no_answer" || l.aiCorrectness === "cannot_judge"
    || l.studentAnswer.trim() === "" || l.studentAnswer.includes("[illegible]");
  return unread && l.reason.trim() === "" && l.teacherAttempt !== null && l.teacherAttempt !== "none";
}

function guidanceSize(g: GuidanceLesson): number {
  return charLength(g.studentAnswer) + charLength(g.reason) + charLength(g.feedback ?? "") + charLength(g.whatStudentDid ?? "")
    + LESSON_OVERHEAD_CHARS + (g.exact === false ? INEXACT_OVERHEAD_CHARS : 0);
}

/** A lesson as the grader receives it: texts trimmed and cut to GUIDANCE_LIMITS; `exact` from rulingIsExact. */
export function toGuidanceLesson(l: Lesson, exact: boolean | null): GuidanceLesson {
  return {
    itemId: l.itemId,
    studentAnswer: clip(l.studentAnswer, GUIDANCE_LIMITS.studentAnswer),
    aiAttempt: l.aiAttempt,
    aiCorrectness: l.aiCorrectness,
    teacherAttempt: l.teacherAttempt,
    teacherCorrectness: l.teacherCorrectness,
    overrideCenti: l.overrideCenti,
    exact: l.overrideCenti === null ? null : exact,
    reason: clip(l.reason, GUIDANCE_LIMITS.reason),
    feedback: l.feedback === null ? null : clip(l.feedback, GUIDANCE_LIMITS.feedback),
    whatStudentDid: l.whatStudentDid === null ? null : clip(l.whatStudentDid, GUIDANCE_LIMITS.whatStudentDid),
  };
}

function clip(s: string, max: number): string {
  return truncateChars(s.trim(), max).trim();
}
