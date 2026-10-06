"use server";

import { refresh } from "next/cache";
import * as z from "zod";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { parseInput } from "@/lib/http/validation";
import { retryKeyExtraction, saveKey } from "@/lib/services/keys";
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
  })),
});

const SaveKeyOptionsSchema = z.object({ open: z.boolean() });

/** Saving also approves the key; with `open` the assignment opens in the same step. */
export async function saveKeyAction(
  assignmentId: string,
  input: SaveKeyInput,
  opts: { open: boolean },
): Promise<ActionResult<{ revision: number; staleCount: number }>> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attemptWithData(() => {
    const options = parseInput(SaveKeyOptionsSchema, opts);
    return saveKey(assignment, parseInput(SaveKeyInputSchema, input), options);
  });
  if (result.ok) refresh();
  return result;
}

export async function retryKeyExtractionAction(assignmentId: string): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => retryKeyExtraction(assignment));
  if (result.ok) refresh();
  return result;
}
