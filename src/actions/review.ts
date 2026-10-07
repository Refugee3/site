"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import * as z from "zod";
import { requireOwnedAssignment, requireOwnedSubmission } from "@/lib/auth/dal";
import { formatPoints } from "@/lib/format";
import { MAX_ITEM_POINTS_CENTI } from "@/lib/grading/scoring";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { parseInput } from "@/lib/http/validation";
import {
  deleteSubmission, gradeManually, markReviewed, regradeStale, regradeSubmission, regradeWithGuidance, retryFailed,
  saveItemOverride, setOverallFeedback, setTotalOverride, updateIdentity,
} from "@/lib/services/submissions";
import type { ActionResult } from "@/lib/types";

// The client parses typed points with parsePointsInput ("7.5" → 750); the server re-checks the result.
const PointsCentiSchema = z
  .number("Enter the points as a number.")
  .int("Use at most two decimals.")
  .min(0, "Points can't be negative.");

const ItemOverrideSchema = z.object({
  pointsCenti: PointsCentiSchema.max(MAX_ITEM_POINTS_CENTI, `Points can be at most ${formatPoints(MAX_ITEM_POINTS_CENTI)}.`).nullable(),
  feedback: z.string().max(2000, "Use at most 2000 characters.").nullable(),
  whatStudentDid: z.string().max(1000, "Use at most 1000 characters.").nullable().optional(),
  // Why the teacher corrected the AI; omitted (or null) keeps the reason already stored with the item's lesson.
  reason: z.string().max(1000, "Use at most 1000 characters.").nullable().optional(),
});

// A total override is not limited to one item's maximum: scoring clamps it to the key's total.
const TotalOverrideSchema = PointsCentiSchema.nullable();

// Length and section membership are checked by the services, which know the limits and the section list.
const ItemIdSchema = z.string();
const OverallFeedbackSchema = z.string();
const IdentitySchema = z.object({ studentName: z.string(), sectionId: z.string().nullable() });

export async function saveItemOverrideAction(
  submissionId: string,
  itemId: string,
  input: { pointsCenti: number | null; feedback: string | null; whatStudentDid?: string | null; reason?: string | null },
): Promise<ActionResult> {
  const { submission } = await requireOwnedSubmission(submissionId);
  const result = await attempt(() =>
    saveItemOverride(submission, parseInput(ItemIdSchema, itemId), parseInput(ItemOverrideSchema, input)));
  if (result.ok) refresh();
  return result;
}

export async function setTotalOverrideAction(submissionId: string, pointsCenti: number | null): Promise<ActionResult> {
  const { submission } = await requireOwnedSubmission(submissionId);
  const result = await attempt(() => setTotalOverride(submission, parseInput(TotalOverrideSchema, pointsCenti)));
  if (result.ok) refresh();
  return result;
}

export async function setOverallFeedbackAction(submissionId: string, text: string): Promise<ActionResult> {
  const { submission } = await requireOwnedSubmission(submissionId);
  const result = await attempt(() => setOverallFeedback(submission, parseInput(OverallFeedbackSchema, text)));
  if (result.ok) refresh();
  return result;
}

export async function updateIdentityAction(
  submissionId: string,
  input: { studentName: string; sectionId: string | null },
): Promise<ActionResult> {
  const { submission } = await requireOwnedSubmission(submissionId);
  const result = await attempt(() => updateIdentity(submission, parseInput(IdentitySchema, input)));
  if (result.ok) refresh();
  return result;
}

/** Returns the next paper that needs review in board order, so the page can move on to it. */
export async function markReviewedAction(submissionId: string): Promise<ActionResult<{ nextId: string | null }>> {
  const { submission } = await requireOwnedSubmission(submissionId);
  const result = await attemptWithData(() => markReviewed(submission));
  if (result.ok) refresh();
  return result;
}

export async function regradeSubmissionAction(submissionId: string): Promise<ActionResult> {
  const { submission } = await requireOwnedSubmission(submissionId);
  const result = await attempt(() => regradeSubmission(submission));
  if (result.ok) refresh();
  return result;
}

export async function gradeManuallyAction(submissionId: string): Promise<ActionResult> {
  const { submission } = await requireOwnedSubmission(submissionId);
  const result = await attempt(() => gradeManually(submission));
  if (result.ok) refresh();
  return result;
}

/** Goes back to the assignment's board afterwards. */
export async function deleteSubmissionAction(submissionId: string): Promise<ActionResult> {
  const { assignment, submission } = await requireOwnedSubmission(submissionId);
  const result = await attempt(() => deleteSubmission(submission));
  if (!result.ok) return result;
  refresh();
  redirect(`/teacher/assignments/${assignment.id}`);
}

export async function regradeStaleAction(assignmentId: string): Promise<ActionResult<{ count: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => ({ count: regradeStale(assignment) }));
  if (result.ok) refresh();
  return result;
}

/** Regrades the unreviewed papers graded before the latest lessons or grading preferences. */
export async function regradeWithGuidanceAction(assignmentId: string): Promise<ActionResult<{ count: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => ({ count: regradeWithGuidance(assignment) }));
  if (result.ok) refresh();
  return result;
}

export async function retryFailedAction(assignmentId: string): Promise<ActionResult<{ count: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => ({ count: retryFailed(assignment) }));
  if (result.ok) refresh();
  return result;
}
