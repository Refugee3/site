"use server";

import { refresh } from "next/cache";
import * as z from "zod";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { attempt } from "@/lib/http/action-result";
import { parseInput } from "@/lib/http/validation";
import { SPOT_KINDS, type QuestionSpots } from "@/lib/omr/types";
import { findSpotsAgain, removeBlankWorksheet, saveSpots } from "@/lib/services/worksheets";
import type { ActionResult } from "@/lib/types";

// The blank worksheet's answer spots (mark detection): saving the teacher's spots (which confirms them), finding them again,
// removing the worksheet. Shape only here; saveSpots keeps every box on the page and within the limits.

const coordinate = z.number("Each box needs numbers.").min(-0.5).max(1.5);
const BoxSchema = z.object({ x: coordinate, y: coordinate, w: coordinate, h: coordinate });
const SpotsSchema: z.ZodType<QuestionSpots[]> = z.array(z.object({
  id: z.string().max(40),
  label: z.string().max(60),
  itemLabel: z.string().max(60).nullable(),
  kind: z.enum(SPOT_KINDS, "Choose how the question is answered."),
  multi: z.boolean(),
  enabled: z.boolean(),
  page: z.number().int().min(1).max(1000),
  options: z.array(z.object({ value: z.string().max(60), box: BoxSchema })).max(20, "A question can have at most 20 options."),
  boxes: z.array(BoxSchema).max(12, "A question can have at most 12 answer areas."),
}), "Send the answer spots as a list.").max(300, "At most 300 questions can have answer spots.");

export async function saveSpotsAction(assignmentId: string, spots: QuestionSpots[]): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => saveSpots(assignment, parseInput(SpotsSchema, spots)));
  if (result.ok) refresh();
  return result;
}

/** `ai`: ask the AI (a scanned blank, or the text layer's spots were poor); otherwise from the PDF's text again. */
export async function findSpotsAgainAction(assignmentId: string, ai: boolean): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => findSpotsAgain(assignment, { ai: ai === true }));
  if (result.ok) refresh();
  return result;
}

export async function removeWorksheetAction(assignmentId: string): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => removeBlankWorksheet(assignment));
  if (result.ok) refresh();
  return result;
}
