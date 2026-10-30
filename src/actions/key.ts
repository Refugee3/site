"use server";

import { refresh } from "next/cache";
import * as z from "zod";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { parseInput } from "@/lib/http/validation";
import { answerKeyQuestions, approveKeyAsIs } from "@/lib/services/key-questions";
import { retryKeyExtraction, saveGradingInstructions, saveKey } from "@/lib/services/keys";
import { ANSWER_TYPES, type ActionResult, type SaveKeyInput } from "@/lib/types";

// Shape only: saveKey (validateSaveKey) owns the content rules and reports them under the same
// "items.<index>.<field>" keys, so the editor highlights both kinds of error alike.
const SaveKeyInputSchema: z.ZodType<SaveKeyInput> = z.object({
  teacherNotes: z.string(),
  acknowledgeAiProposed: z.boolean(),
  items: z.array(z.object({
    id: z.string().nullable(),
    label: z.string(),
    groupLabel: z.string(),
    prompt: z.string(),
    answerType: z.enum(ANSWER_TYPES, "Choose an answer type."),
    expectedAnswer: z.string(),
    acceptableAnswers: z.array(z.string()),
    gradingCriteria: z.string(),
    pointsCenti: z.number("Enter the points as a number."),
    partialCredit: z.boolean(),
    page: z.number("Enter the page as a number.").nullable(),
    graded: z.boolean().optional(),
  })),
});

/** Saving also approves the key. */
export async function saveKeyAction(
  assignmentId: string,
  input: SaveKeyInput,
): Promise<ActionResult<{ revision: number; staleCount: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => saveKey(assignment, parseInput(SaveKeyInputSchema, input)));
  if (result.ok) refresh();
  return result;
}

/** Reads the key PDF again; `instructions` (the "Instructions for the AI" box) replace the key's instructions first. */
export async function retryKeyExtractionAction(assignmentId: string, instructions?: string): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const text = instructions === undefined ? undefined : parseInput(z.string("Send the instructions as text."), instructions);
  const result = await attempt(() => retryKeyExtraction(assignment, text));
  if (result.ok) refresh();
  return result;
}

const AnswersSchema = z.array(z.object({ id: z.string(), answer: z.string().nullable() }), "Send the answers as a list.")
  .max(50, "Too many answers.");

/** The workspace's "Save answers and continue": the AI's questions about the key, answered (or skipped) and applied to it. */
export async function answerKeyQuestionsAction(
  assignmentId: string,
  answers: Array<{ id: string; answer: string | null }>,
): Promise<ActionResult<{ answered: number; skipped: number; changedItems: number; notes: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => answerKeyQuestions(assignment, parseInput(AnswersSchema, answers)));
  if (result.ok) refresh();
  return result;
}

const ApproveSchema = z.object({ acknowledgeAiProposed: z.boolean(), seenUpdatedAt: z.number() });

/** The workspace's "Approve key": approves the key as stored, the version the teacher saw (see approveKeyAsIs). */
export async function approveKeyAction(
  assignmentId: string,
  input: { acknowledgeAiProposed: boolean; seenUpdatedAt: number },
): Promise<ActionResult<{ revision: number; staleCount: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => approveKeyAsIs(assignment, parseInput(ApproveSchema, input)));
  if (result.ok) refresh();
  return result;
}

const InstructionsSchema = z.object({
  text: z.string("Send the instructions as text."),
  gradedItemIds: z.array(z.string()).max(1000).optional(),
});

/** The upload page's "Grading instructions" box: saves just the key's instructions for the AI. */
export async function saveGradingInstructionsAction(
  assignmentId: string,
  input: { text: string; gradedItemIds?: string[] },
): Promise<ActionResult<{ changed: boolean; staleCount: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => saveGradingInstructions(assignment, parseInput(InstructionsSchema, input)));
  if (result.ok) refresh();
  return result;
}
