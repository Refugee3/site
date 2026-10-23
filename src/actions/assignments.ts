"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import * as z from "zod";
import { requireOwnedAssignment, requireTeacher } from "@/lib/auth/dal";
import { AppError } from "@/lib/errors";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { formFields, parseInput } from "@/lib/http/validation";
import {
  AssignmentFormSchema, createAssignment, deleteAssignment, renameAssignment, updateAssignment,
} from "@/lib/services/assignments";
import type { ActionResult, AssignmentFormInput } from "@/lib/types";

const ASSIGNMENT_FIELDS = [
  "title", "kind", "instructions", "gradingMode", "accuracyWeight", "sectionsText", "maxSubmissions", "writeNotes",
] as const satisfies ReadonlyArray<keyof AssignmentFormInput>;

const ConfirmTitleSchema = z.string("Type the assignment's title to confirm.");

function assignmentForm(fd: FormData): AssignmentFormInput {
  return parseInput(AssignmentFormSchema, formFields(fd, ASSIGNMENT_FIELDS));
}

export async function createAssignmentAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const teacher = await requireTeacher();
  const result = await attemptWithData(() => createAssignment(teacher.id, assignmentForm(fd)).id);
  if (!result.ok) return result;
  refresh();
  redirect(`/teacher/assignments/${result.data}/key`);
}

export async function updateAssignmentAction(assignmentId: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => updateAssignment(assignment, assignmentForm(fd)));
  if (!result.ok) return result;
  refresh();
  return { ok: true, message: "Settings saved." };
}

/** The workspace's inline title. */
export async function renameAssignmentAction(assignmentId: string, title: string): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => renameAssignment(assignment, parseInput(z.string("Give the assignment a title."), title)));
  if (result.ok) refresh();
  return result;
}

/** The teacher confirms by typing the title (fd.confirmTitle). */
export async function deleteAssignmentAction(assignmentId: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(async () => {
    const confirmTitle = parseInput(ConfirmTitleSchema, formFields(fd, ["confirmTitle"]).confirmTitle);
    if (confirmTitle.trim() !== assignment.title.trim()) {
      const message = "Type the assignment's title exactly as shown to confirm.";
      throw new AppError("validation", message, { fieldErrors: { confirmTitle: [message] } });
    }
    await deleteAssignment(assignment);
  });
  if (!result.ok) return result;
  refresh();
  redirect("/teacher");
}
