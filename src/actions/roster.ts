"use server";

import { refresh } from "next/cache";
import * as z from "zod";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { attempt } from "@/lib/http/action-result";
import { parseInput } from "@/lib/http/validation";
import { copyPreviousRoster, saveRoster } from "@/lib/services/rosters";
import type { ActionResult } from "@/lib/types";

// The assignment's class list (Settings tab): names read on papers are matched to it.

const RosterSchema = z.string("Paste the class list as text.").max(40_000, "The class list is too long.");

export async function saveRosterAction(assignmentId: string, text: string): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => {
    saveRoster(assignment, parseInput(RosterSchema, text));
  });
  if (result.ok) refresh();
  return result;
}

/** Copies the class list of the teacher's most recent other assignment that has one. */
export async function copyPreviousRosterAction(assignmentId: string): Promise<ActionResult> {
  const { assignment } = await requireOwnedAssignment(assignmentId);
  const result = await attempt(() => {
    copyPreviousRoster(assignment);
  });
  if (result.ok) refresh();
  return result;
}
