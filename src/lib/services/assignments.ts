import * as z from "zod";
import { now } from "@/lib/clock";
import { tx } from "@/lib/db/connection";
import {
  deleteAssignmentRow, getAssignment, insertAssignment, latestSectionsForTeacher, listSections, replaceSections,
  shareCodeExists, updateAssignment as updateAssignmentRow,
} from "@/lib/db/repos/assignments";
import { createEmptyKey } from "@/lib/db/repos/keys";
import { AppError } from "@/lib/errors";
import { parseSectionsText, sectionsToText, type ParsedSection } from "@/lib/grading/sections";
import { newId, newShareCode } from "@/lib/ids";
import { loadKeyState } from "@/lib/services/key-state";
import { studentUploadsEnabled } from "@/lib/services/settings";
import { rematchSections, rescoreAssignment } from "@/lib/services/submissions";
import { removeAssignmentFiles } from "@/lib/storage/files";
import { ASSIGNMENT_KINDS, GRADING_MODES, type Assignment, type AssignmentFormInput, type Section } from "@/lib/types";

const MAX_SECTIONS = 50;
const SHARE_CODE_TRIES = 5;

/** Parses the sections textarea and applies the per-assignment limit; `errors` are teacher-readable. */
function readSections(text: string): { sections: ParsedSection[]; errors: string[] } {
  const { sections, errors } = parseSectionsText(text);
  if (sections.length > MAX_SECTIONS) return { sections, errors: [...errors, `List at most ${MAX_SECTIONS} sections.`] };
  return { sections, errors };
}

/** The create/edit form. FormData numbers arrive as strings, hence the coercion. */
export const AssignmentFormSchema: z.ZodType<AssignmentFormInput> = z.object({
  title: z.string().trim().min(1, "Give the assignment a title.").max(200, "Use at most 200 characters."),
  kind: z.enum(ASSIGNMENT_KINDS, "Choose Homework or Quiz.").default("homework"),
  instructions: z.string().trim().max(2000, "Use at most 2000 characters.").default(""),
  gradingMode: z.enum(GRADING_MODES).default("completion"),
  accuracyWeight: z.coerce.number().int().min(0).max(100).multipleOf(5, "Use a multiple of 5.").default(50),
  sectionsText: z.string().max(5000, "Use at most 5000 characters.").default("").superRefine((text, ctx) => {
    for (const message of readSections(text).errors) ctx.addIssue({ code: "custom", message });
  }),
  maxSubmissions: z.coerce.number().int().min(1).max(5000).default(500),
});

/** Callers pass input already validated with AssignmentFormSchema; this only guards against a bypass. */
function sectionsFromInput(text: string): ParsedSection[] {
  const { sections, errors } = readSections(text);
  if (errors.length > 0) {
    throw new AppError("validation", "Fix the sections list.", { fieldErrors: { sectionsText: errors } });
  }
  return sections;
}

/** A draft with an empty answer key, its sections and a fresh share code. */
export function createAssignment(teacherId: string, i: AssignmentFormInput): Assignment {
  const sections = sectionsFromInput(i.sectionsText);
  return tx(() => {
    const assignment = insertAssignment({
      id: newId(),
      teacherId,
      title: i.title,
      kind: i.kind,
      instructions: i.instructions,
      gradingMode: i.gradingMode,
      accuracyWeight: i.accuracyWeight,
      shareCode: unusedShareCode(),
      maxSubmissions: i.maxSubmissions,
    });
    createEmptyKey(assignment.id);
    replaceSections(assignment.id, sections);
    return assignment;
  });
}

/** Saves the settings; a new grading mode or weight rescores and a new section list re-matches, without AI calls. */
export function updateAssignment(a: Assignment, i: AssignmentFormInput): Assignment {
  const sections = sectionsFromInput(i.sectionsText);
  return tx(() => {
    const before = requireAssignment(a.id);
    const updated = updateAssignmentRow(a.id, {
      title: i.title,
      kind: i.kind,
      instructions: i.instructions,
      gradingMode: i.gradingMode,
      accuracyWeight: i.accuracyWeight,
      maxSubmissions: i.maxSubmissions,
    });
    if (!sameSections(listSections(a.id), sections)) {
      replaceSections(a.id, sections);
      rematchSections(a.id);
    }
    if (before.gradingMode !== updated.gradingMode || before.accuracyWeight !== updated.accuracyWeight) {
      rescoreAssignment(a.id);
    }
    return updated;
  });
}

function sameSections(current: Section[], next: ParsedSection[]): boolean {
  const shape = (s: ParsedSection) => [s.label, s.aliases, s.canonicalKey];
  return JSON.stringify(current.map(shape)) === JSON.stringify(next.map(shape));
}

/** draft → open (needs an approved key, and student uploads turned on in Settings) → closed → open. */
export function setAssignmentStatus(a: Assignment, to: "open" | "closed"): Assignment {
  return tx(() => {
    const current = requireAssignment(a.id);
    if (to === "open" && !studentUploadsEnabled()) {
      throw new AppError("invalid_state", "Student submissions are turned off. Turn them on in Settings to open an assignment.");
    }
    if (to === "open" && !loadKeyState(a.id).approved) {
      throw new AppError("key_not_ready", "Approve the answer key before opening the assignment.");
    }
    if (to === "closed" && current.status === "draft") {
      throw new AppError("invalid_state", "This assignment hasn't been opened yet.");
    }
    return current.status === to ? current : updateAssignmentRow(a.id, { status: to });
  });
}

/** Students see released results on their receipts; releasing again keeps the original release time. */
export function setFeedbackReleased(a: Assignment, released: boolean): Assignment {
  return tx(() => {
    const current = requireAssignment(a.id);
    if (released === (current.feedbackReleasedAt !== null)) return current;
    return updateAssignmentRow(a.id, { feedbackReleasedAt: released ? now() : null });
  });
}

/** The old link stops working at once; receipts are unaffected. */
export function rotateShareCode(a: Assignment): Assignment {
  return tx(() => updateAssignmentRow(a.id, { shareCode: unusedShareCode() }));
}

/** Deletes the assignment with everything in it (rows by cascade, then the stored PDFs). */
export async function deleteAssignment(a: Assignment): Promise<void> {
  deleteAssignmentRow(a.id);
  await removeAssignmentFiles(a.id);
}

/** The sections of the teacher's most recent assignment, as the textarea prefill for a new one. */
export function defaultSectionsText(teacherId: string): string {
  return sectionsToText(latestSectionsForTeacher(teacherId));
}

/** Must run inside the transaction that stores the code, so the existence check cannot go stale. */
function unusedShareCode(): string {
  for (let attempt = 0; attempt < SHARE_CODE_TRIES; attempt++) {
    const code = newShareCode();
    if (!shareCodeExists(code)) return code;
  }
  throw new AppError("conflict", "Could not create a unique share code. Try again.");
}

function requireAssignment(id: string): Assignment {
  const assignment = getAssignment(id);
  if (!assignment) throw new AppError("not_found", "This assignment no longer exists.");
  return assignment;
}
