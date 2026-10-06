import { getKey, listKeyItems } from "@/lib/db/repos/keys";
import { listIdsByStatus } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { isKeyApproved } from "@/lib/grading/key";
import type { AnswerKey, KeyItem, SubmissionStatus } from "@/lib/types";

// Answer-key facts several services and views need. A leaf of the services import graph (repos and grading only).

/** Papers in these states were graded against the current key items, which extraction would replace. */
const KEY_LOCKING_STATUSES: SubmissionStatus[] = ["grading", "graded", "needs_review"];

/** Every assignment gets its key row at creation, so a missing one means the assignment is gone. */
export function requireKey(assignmentId: string): AnswerKey {
  const key = getKey(assignmentId);
  if (!key) throw new AppError("not_found", "This assignment no longer exists.");
  return key;
}

export function loadKeyState(assignmentId: string): { key: AnswerKey; items: KeyItem[]; approved: boolean } {
  const key = requireKey(assignmentId);
  const items = listKeyItems(assignmentId);
  return { key, items, approved: isKeyApproved(key, items.length) };
}

/** True once any paper is being or has been graded: a replacement key PDF (or re-extraction) is then refused. */
export function isKeyLocked(assignmentId: string): boolean {
  return listIdsByStatus(assignmentId, KEY_LOCKING_STATUSES).length > 0;
}
