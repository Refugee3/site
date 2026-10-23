"use server";

import { refresh } from "next/cache";
import * as z from "zod";
import { requireOwnedLesson } from "@/lib/auth/dal";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { parseInput } from "@/lib/http/validation";
import { addLessonToPreferences, deleteLesson, setLessonActive, updateLessonReason } from "@/lib/services/lessons";
import type { ActionResult } from "@/lib/types";

// Bounded before it reaches the service, which trims it and enforces the stored limit.
const ReasonSchema = z.string("Write the reason as text.").max(4000, "Use at most 1000 characters.");
const ActiveSchema = z.boolean();

export async function updateLessonReasonAction(lessonId: string, reason: string): Promise<ActionResult> {
  const { lesson } = await requireOwnedLesson(lessonId);
  const result = await attempt(() => updateLessonReason(lesson, parseInput(ReasonSchema, reason)));
  if (result.ok) refresh();
  return result;
}

/** A lesson that is off stays listed but is not sent to the grader. */
export async function setLessonActiveAction(lessonId: string, active: boolean): Promise<ActionResult> {
  const { lesson } = await requireOwnedLesson(lessonId);
  const result = await attempt(() => setLessonActive(lesson, parseInput(ActiveSchema, active)));
  if (result.ok) refresh();
  return result;
}

/** `deleted` is false when the lesson's paper still exists: the lesson is turned off instead (see deleteLesson). */
export async function deleteLessonAction(lessonId: string): Promise<ActionResult<{ deleted: boolean }>> {
  const { lesson } = await requireOwnedLesson(lessonId);
  const result = await attemptWithData(() => deleteLesson(lesson));
  if (result.ok) refresh();
  return result;
}

/** `added` is false when the reason is already one of the teacher's grading preferences. */
export async function addLessonToPreferencesAction(lessonId: string): Promise<ActionResult<{ added: boolean }>> {
  const { teacher, lesson } = await requireOwnedLesson(lessonId);
  const result = await attemptWithData(() => addLessonToPreferences(teacher, lesson));
  if (result.ok) refresh();
  return result;
}
