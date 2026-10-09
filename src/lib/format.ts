import type { AnswerType, AssignmentKind, Attempt, Correctness, ItemOutcome, ItemReviewReason, SubmissionStatus } from "@/lib/types";

const NONE = "—";

/** Centipoints to points text: 750 → "7.5", 1000 → "10", 5 → "0.05". */
export function formatPoints(centi: number | null): string {
  if (centi === null) return NONE;
  // toFixed picks the closest decimal, so integer / 100 always prints exactly.
  return (Math.round(centi) / 100).toFixed(2).replace(/\.?0+$/, "");
}

/** Tenths of a percent to text: 875 → "87.5%", 1000 → "100%". */
export function formatPercent(tenths: number | null): string {
  if (tenths === null) return NONE;
  return `${(Math.round(tenths) / 10).toFixed(1).replace(/\.0$/, "")}%`;
}

const POINTS_INPUT_RE = /^(\d*)(?:\.(\d{0,2}))?$/;

/**
 * Parses a teacher's points entry into centipoints: "7.5" → 750, "" → null.
 * Anything that is not a non-negative number with at most two decimals is NaN.
 */
export function parsePointsInput(s: string): number | null {
  const text = s.trim();
  if (text === "") return null;
  const match = POINTS_INPUT_RE.exec(text);
  if (!match || (match[1] === "" && !match[2])) return Number.NaN;
  const whole = Number(match[1] || "0");
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;
}

export function formatShareCode(code: string): string {
  return code.toUpperCase();
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "Homework" / "Quiz": the assignment's badge and form label. */
export const KIND_LABEL: Record<AssignmentKind, string> = { homework: "Homework", quiz: "Quiz" };

/** The lowercase noun for wording that follows the kind: "homework" (never plural) or "quiz"/"quizzes". */
export function kindNoun(kind: AssignmentKind, plural = false): string {
  if (kind === "homework") return "homework";
  return plural ? "quizzes" : "quiz";
}

/** The upload tab and buttons while the teacher uploads every paper: "Upload homework" / "Upload quizzes". */
export function uploadLabel(kind: AssignmentKind): string {
  return `Upload ${kindNoun(kind, true)}`;
}

export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  queued: "Queued",
  grading: "Grading",
  graded: "Graded",
  needs_review: "Needs review",
  failed: "Failed",
};

export const ATTEMPT_LABEL: Record<Attempt, string> = {
  complete: "Complete",
  partial: "Partial",
  none: "Not attempted",
};

export const CORRECTNESS_LABEL: Record<Correctness, string> = {
  correct: "Correct",
  minor_error: "Minor error",
  partially_correct: "Partially correct",
  major_error: "Major error",
  incorrect: "Incorrect",
  no_answer: "No answer",
  cannot_judge: "Can't judge",
};

/** How a paper did on one question, on the board's "missed" filter and the Questions tab. */
export const OUTCOME_LABEL: Record<ItemOutcome, string> = {
  correct: "Correct",
  partly: "Partly right",
  wrong: "Wrong",
  blank: "Blank",
  unreadable: "Unreadable",
};

export const REVIEW_REASON_LABEL: Record<ItemReviewReason, string> = {
  none: "None",
  alternate_answer: "Alternate answer",
  key_may_be_wrong: "Key may be wrong",
  multiple_answers: "Multiple answers",
  ambiguous_reading: "Ambiguous reading",
  other: "Other",
};

export const ANSWER_TYPE_LABEL: Record<AnswerType, string> = {
  multiple_choice: "Multiple choice",
  true_false: "True / false",
  numeric: "Numeric",
  short_answer: "Short answer",
  long_answer: "Long answer",
  fill_in_blank: "Fill in the blank",
  matching: "Matching",
  diagram: "Diagram",
  other: "Other",
};
