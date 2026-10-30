import * as z from "zod";
import { tx } from "@/lib/db/connection";
import {
  deleteAssignmentRow, getAssignment, insertAssignment, latestSectionsForTeacher, listSections, replaceSections,
  shareCodeExists, updateAssignment as updateAssignmentRow,
} from "@/lib/db/repos/assignments";
import { createEmptyKey, getKey, updateKey } from "@/lib/db/repos/keys";
import { AppError } from "@/lib/errors";
import { placeholderTitle } from "@/lib/grading/key-questions";
import { parseSectionsText, sectionsToText, type ParsedSection } from "@/lib/grading/sections";
import { newId, newShareCode } from "@/lib/ids";
import { ingestKeyPdf } from "@/lib/services/keys";
import { rematchSections, rescoreAssignment } from "@/lib/services/submissions";
import { removeAssignmentFiles } from "@/lib/storage/files";
import type { UploadedFile } from "@/lib/storage/pdf";
import { ASSIGNMENT_KINDS, GRADING_MODES, PROJECT_MODES, type Assignment, type ProjectMode, type AssignmentFormInput, type AssignmentKind, type Section } from "@/lib/types";

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
  kind: z.enum(ASSIGNMENT_KINDS, "Choose Homework, Quiz or Project.").default("homework"),
  projectMode: z.enum(PROJECT_MODES, "Choose points or feedback only.").optional(),
  gradingInstructions: z.string().trim().max(4000, "Use at most 4000 characters.").optional(),
  instructions: z.string().trim().max(2000, "Use at most 2000 characters.").default(""),
  gradingMode: z.enum(GRADING_MODES).default("completion"),
  accuracyWeight: z.coerce.number().int().min(0).max(100).multipleOf(5, "Use a multiple of 5.").default(50),
  sectionsText: z.string().max(5000, "Use at most 5000 characters.").default("").superRefine((text, ctx) => {
    for (const message of readSections(text).errors) ctx.addIssue({ code: "custom", message });
  }),
  maxSubmissions: z.coerce.number().int().min(1).max(5000).default(500),
  // A checkbox: present ("on") when ticked, missing when not. Off by default.
  writeNotes: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()),
});

/** Callers pass input already validated with AssignmentFormSchema; this only guards against a bypass. */
function sectionsFromInput(text: string): ParsedSection[] {
  const { sections, errors } = readSections(text);
  if (errors.length > 0) {
    throw new AppError("validation", "Fix the sections list.", { fieldErrors: { sectionsText: errors } });
  }
  return sections;
}

/** An assignment with an empty answer key and its sections (its share code column is unused but must be unique). */
export function createAssignment(teacherId: string, i: AssignmentFormInput): Assignment {
  const sections = sectionsFromInput(i.sectionsText);
  return tx(() => {
    const assignment = insertAssignment({
      id: newId(),
      teacherId,
      title: i.title,
      kind: i.kind,
      projectMode: i.kind === "project" ? (i.projectMode ?? "points") : null,
      instructions: i.instructions,
      writeNotes: i.writeNotes,
      gradingMode: i.gradingMode,
      accuracyWeight: i.accuracyWeight,
      shareCode: unusedShareCode(),
      maxSubmissions: i.maxSubmissions,
    });
    createEmptyKey(assignment.id);
    // A project is graded from its instructions: they are the key's grading instructions.
    if (i.kind === "project" && i.gradingInstructions) updateKey(assignment.id, { teacherNotes: i.gradingInstructions });
    replaceSections(assignment.id, sections);
    return assignment;
  });
}

/**
 * Starts an assignment from its answer key alone (dropped on the dashboard): "Untitled homework" or "Untitled quiz" until the
 * AI's reading of the key suggests a title, the new-assignment form's defaults and the sections of the teacher's latest
 * assignment; then the key is stored and queued for reading. A key that can't be stored (not a readable file, too many pages)
 * takes the new assignment with it, so a failed drop leaves nothing behind.
 */
export async function createAssignmentFromKey(
  teacherId: string,
  kind: AssignmentKind,
  files: UploadedFile[],
  instructions?: string,
): Promise<Assignment> {
  const assignment = createAssignment(teacherId, {
    title: placeholderTitle(kind),
    kind,
    instructions: "",
    gradingMode: "completion",
    accuracyWeight: 50,
    sectionsText: defaultSectionsText(teacherId),
    maxSubmissions: 500,
    writeNotes: false,
  });
  try {
    await ingestKeyPdf(assignment, files, instructions);
  } catch (e) {
    await deleteAssignment(assignment);
    throw e;
  }
  return assignment;
}

/**
 * Starts a project from the dashboard: "Untitled project" (the teacher renames it), graded from `instructions` with points or
 * as feedback only. A rubric or key, when dropped with it, is read like an answer key (the instructions guide the reading);
 * without one the project is ready for papers as soon as it has instructions.
 */
export async function createProject(
  teacherId: string,
  i: { files: UploadedFile[]; instructions: string; mode: ProjectMode },
): Promise<Assignment> {
  const instructions = i.instructions.trim();
  if (i.files.length === 0 && instructions === "") {
    throw new AppError("validation", "Say what the AI should grade or write, or drop a rubric.");
  }
  const assignment = createAssignment(teacherId, {
    title: placeholderTitle("project"),
    kind: "project",
    projectMode: i.mode,
    gradingInstructions: instructions.slice(0, 4000),
    instructions: "",
    gradingMode: "completion",
    accuracyWeight: 50,
    sectionsText: defaultSectionsText(teacherId),
    maxSubmissions: 500,
    writeNotes: false,
  });
  if (i.files.length === 0) return assignment;
  try {
    await ingestKeyPdf(assignment, i.files, instructions);
  } catch (e) {
    await deleteAssignment(assignment);
    throw e;
  }
  return assignment;
}

export const TitleSchema = z.string("Give the assignment a title.").trim().min(1, "Give the assignment a title.")
  .max(200, "Use at most 200 characters.");

/** Renames the assignment (the workspace's inline title). */
export function renameAssignment(a: Assignment, title: string): Assignment {
  const parsed = TitleSchema.safeParse(title);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Give the assignment a title.";
    throw new AppError("validation", message, { fieldErrors: { title: [message] } });
  }
  return updateAssignmentRow(a.id, { title: parsed.data });
}

/**
 * Saves the settings; a new grading mode or weight rescores and a new section list re-matches, without AI calls. Turning
 * notes on or off applies to papers graded from then on: graded papers are not marked stale.
 */
export function updateAssignment(a: Assignment, i: AssignmentFormInput): Assignment {
  const sections = sectionsFromInput(i.sectionsText);
  return tx(() => {
    const before = requireAssignment(a.id);
    const updated = updateAssignmentRow(a.id, {
      title: i.title,
      kind: i.kind,
      ...(i.kind === "project" ? { projectMode: i.projectMode ?? before.projectMode ?? "points" } : {}),
      instructions: i.instructions,
      writeNotes: i.writeNotes,
      gradingMode: i.gradingMode,
      accuracyWeight: i.accuracyWeight,
      maxSubmissions: i.maxSubmissions,
    });
    if (!sameSections(listSections(a.id), sections)) {
      replaceSections(a.id, sections);
      rematchSections(a.id);
    }
    // A project switched between points and feedback only: reviewed projects are stale (Regrade stale reviews them again).
    if (before.kind === "project" && updated.kind === "project" && before.projectMode !== updated.projectMode) {
      const key = getKey(a.id);
      if (key) {
        const approved = key.approvedRevision === key.revision;
        updateKey(a.id, { revision: key.revision + 1, ...(approved ? { approvedRevision: key.revision + 1 } : {}) });
      }
    }
    if (before.gradingMode !== updated.gradingMode || before.accuracyWeight !== updated.accuracyWeight
      || before.kind !== updated.kind || before.projectMode !== updated.projectMode) {
      rescoreAssignment(a.id);
    }
    return updated;
  });
}

function sameSections(current: Section[], next: ParsedSection[]): boolean {
  const shape = (s: ParsedSection) => [s.label, s.aliases, s.canonicalKey];
  return JSON.stringify(current.map(shape)) === JSON.stringify(next.map(shape));
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
