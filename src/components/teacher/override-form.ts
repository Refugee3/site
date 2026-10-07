import type { ReviewItemView } from "@/lib/types";

// The pure parts of an item's override form on the review page (item-card.tsx): what is unsaved, what a save
// sends, and what became of the correction.

/** The form's fields as typed: points (text), the two notes the student reads, and why the teacher corrected the AI. */
export interface OverrideTexts {
  points: string;
  feedback: string;
  note: string;
  reason: string;
}

export interface OverrideContext {
  /** The fields as stored (an unchanged note shows the AI's text). */
  stored: OverrideTexts;
  aiFeedback: string;
  aiNote: string;
  /** The item has a stored override of its points, feedback or note. */
  hasOverride: boolean;
  /** The AI read the answer, so the grader can learn from a correction of it (a paper graded by hand keeps no lesson). */
  learnable: boolean;
}

export interface OverrideRequest {
  pointsCenti: number | null;
  feedback: string | null;
  whatStudentDid: string | null;
  reason?: string;
}

/** Text left as the AI wrote it is not an override, so a later regrade can still replace it. */
export function overrideText(text: string, aiText: string): string | null {
  const trimmed = text.trim();
  return trimmed === aiText.trim() ? null : trimmed;
}

/**
 * `correcting`: there is a correction, stored or being typed. `reasonLive`: the reason field can be written, because
 * a reason is kept only with a correction the grader can learn from. `dirty`: something would be saved; a reason typed
 * while the field is not live counts for nothing (the server would drop it), so it never leaves the form "unsaved".
 */
export function overrideFormState(texts: OverrideTexts, ctx: OverrideContext): { correcting: boolean; reasonLive: boolean; dirty: boolean } {
  const correcting = ctx.hasOverride || texts.points.trim() !== ""
    || overrideText(texts.feedback, ctx.aiFeedback) !== null || overrideText(texts.note, ctx.aiNote) !== null;
  const reasonLive = correcting && ctx.learnable;
  const dirty = texts.points !== ctx.stored.points || texts.feedback !== ctx.stored.feedback || texts.note !== ctx.stored.note
    || (reasonLive && texts.reason !== ctx.stored.reason);
  return { correcting, reasonLive, dirty };
}

/**
 * What a save of these fields sends (`pointsCenti` already parsed). The reason goes only when it changed and the save
 * leaves a correction the grader can learn from; otherwise it is omitted, so the stored reason stays (and goes with
 * the lesson once the last override is cleared).
 */
export function overrideRequest(texts: OverrideTexts, pointsCenti: number | null, ctx: OverrideContext): OverrideRequest {
  const feedback = overrideText(texts.feedback, ctx.aiFeedback);
  const whatStudentDid = overrideText(texts.note, ctx.aiNote);
  const leavesCorrection = pointsCenti !== null || feedback !== null || whatStudentDid !== null;
  const sendReason = ctx.learnable && leavesCorrection && texts.reason !== ctx.stored.reason;
  return { pointsCenti, feedback, whatStudentDid, ...(sendReason ? { reason: texts.reason } : {}) };
}

/**
 * What became of the correction, shown under the form: whether the grader learns from it and, if not, why (the same
 * reasons as the Lessons tab). Only right after a save, except for a lesson turned off, which always says so.
 */
export function lessonStatusText(lesson: ReviewItemView["lesson"], saved: boolean): string | null {
  if (!lesson) return null;
  if (!lesson.active) return "This lesson is turned off on the Lessons tab.";
  if (!saved) return null;
  if (lesson.sent) return "Saved. The grader learns from this correction.";
  switch (lesson.notSent) {
    case "agrees":
      return "Saved. This matches the AI's judgment, so the grader learns from it only if you say why.";
    case "reading_fix":
      return "Saved. The AI couldn't read this answer, so the grader learns from it only if you say why.";
    case "no_reading":
      return "Saved. The AI never read this answer, so the grader can't learn from it.";
    case "limit":
      return "Saved. Only the newest lessons fit, so the grader isn't sent this one.";
    default:
      return "Saved.";
  }
}
