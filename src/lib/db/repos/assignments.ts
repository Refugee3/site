import { now } from "@/lib/clock";
import { tx } from "@/lib/db/connection";
import { all, encodePatch, one, run, updateRow, type ColumnMap } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { AiUsage, Assignment, AssignmentStatus, GradingMode, Section } from "@/lib/types";

interface AssignmentRow {
  id: string;
  teacher_id: string;
  title: string;
  instructions: string;
  status: AssignmentStatus;
  grading_mode: GradingMode;
  accuracy_weight: number;
  share_code: string;
  max_submissions: number;
  feedback_released_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SectionRow {
  id: string;
  assignment_id: string;
  label: string;
  aliases_json: string;
  canonical_key: string;
  sort_order: number;
}

function assignmentFromRow(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    gradingMode: row.grading_mode,
    accuracyWeight: row.accuracy_weight,
    shareCode: row.share_code,
    maxSubmissions: row.max_submissions,
    feedbackReleasedAt: row.feedback_released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sectionFromRow(row: SectionRow): Section {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    label: row.label,
    aliases: JSON.parse(row.aliases_json) as string[],
    canonicalKey: row.canonical_key,
    sortOrder: row.sort_order,
  };
}

export function insertAssignment(
  a: Pick<Assignment, "id" | "teacherId" | "title" | "instructions" | "gradingMode" | "accuracyWeight" | "shareCode" | "maxSubmissions">,
): Assignment {
  const at = now();
  const row = one<AssignmentRow>(
    `INSERT INTO assignments (id, teacher_id, title, instructions, grading_mode, accuracy_weight, share_code, max_submissions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    a.id, a.teacherId, a.title, a.instructions, a.gradingMode, a.accuracyWeight, a.shareCode, a.maxSubmissions, at, at,
  );
  return assignmentFromRow(row!);
}

export function getAssignment(id: string): Assignment | null {
  const row = one<AssignmentRow>("SELECT * FROM assignments WHERE id = ?", id);
  return row ? assignmentFromRow(row) : null;
}

export function getAssignmentForTeacher(id: string, teacherId: string): Assignment | null {
  const row = one<AssignmentRow>("SELECT * FROM assignments WHERE id = ? AND teacher_id = ?", id, teacherId);
  return row ? assignmentFromRow(row) : null;
}

export function getAssignmentByShareCode(code: string): (Assignment & { teacherName: string }) | null {
  const row = one<AssignmentRow & { teacher_name: string }>(
    `SELECT a.*, t.display_name AS teacher_name
     FROM assignments a JOIN teachers t ON t.id = a.teacher_id
     WHERE a.share_code = ?`,
    code,
  );
  return row ? { ...assignmentFromRow(row), teacherName: row.teacher_name } : null;
}

/** Newest first. */
export function listAssignmentsForTeacher(teacherId: string): Assignment[] {
  return all<AssignmentRow>(
    "SELECT * FROM assignments WHERE teacher_id = ? ORDER BY created_at DESC, rowid DESC",
    teacherId,
  ).map(assignmentFromRow);
}

type AssignmentPatch = Pick<Assignment, "title" | "instructions" | "status" | "gradingMode" | "accuracyWeight" | "shareCode"
  | "maxSubmissions" | "feedbackReleasedAt">;

const ASSIGNMENT_COLUMNS: ColumnMap<AssignmentPatch> = {
  title: "title",
  instructions: "instructions",
  status: "status",
  gradingMode: "grading_mode",
  accuracyWeight: "accuracy_weight",
  shareCode: "share_code",
  maxSubmissions: "max_submissions",
  feedbackReleasedAt: "feedback_released_at",
};

/** Throws AppError("not_found") when the assignment does not exist. */
export function updateAssignment(id: string, patch: Partial<AssignmentPatch>): Assignment {
  const row = updateRow<AssignmentRow>("assignments", { id }, encodePatch(patch, ASSIGNMENT_COLUMNS));
  if (!row) throw new AppError("not_found", "Assignment not found.");
  return assignmentFromRow(row);
}

/** Deletes the assignment and, by cascade, its sections, key, submissions and jobs. */
export function deleteAssignmentRow(id: string): void {
  run("DELETE FROM assignments WHERE id = ?", id);
}

export function shareCodeExists(code: string): boolean {
  return one("SELECT 1 FROM assignments WHERE share_code = ?", code) !== undefined;
}

export function listSections(assignmentId: string): Section[] {
  return all<SectionRow>("SELECT * FROM sections WHERE assignment_id = ? ORDER BY sort_order", assignmentId)
    .map(sectionFromRow);
}

/**
 * Makes the assignment's sections exactly `sections`, in that order. A section whose canonicalKey
 * survives keeps its id (so submissions stay in it); removed sections leave their submissions unsectioned.
 * A teacher's choice of a removed section no longer stands either (section_source is reset), so the
 * caller's re-match (rematchSections) places those papers again or flags them as unmatched.
 */
export function replaceSections(
  assignmentId: string,
  sections: Array<{ label: string; aliases: string[]; canonicalKey: string }>,
): Section[] {
  return tx(() => {
    const existing = new Map(listSections(assignmentId).map((s) => [s.canonicalKey, s]));
    const kept = new Set(sections.map((s) => s.canonicalKey));
    for (const section of existing.values()) {
      if (kept.has(section.canonicalKey)) continue;
      run("UPDATE submissions SET section_source = NULL WHERE section_id = ? AND section_source = 'teacher'", section.id);
      run("DELETE FROM sections WHERE id = ?", section.id);
    }
    sections.forEach((section, sortOrder) => {
      const aliasesJson = JSON.stringify(section.aliases);
      const current = existing.get(section.canonicalKey);
      if (current) {
        run(
          "UPDATE sections SET label = ?, aliases_json = ?, sort_order = ? WHERE id = ?",
          section.label, aliasesJson, sortOrder, current.id,
        );
      } else {
        run(
          `INSERT INTO sections (id, assignment_id, label, aliases_json, canonical_key, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          newId(), assignmentId, section.label, aliasesJson, section.canonicalKey, sortOrder,
        );
      }
    });
    return listSections(assignmentId);
  });
}

/** Sections of the teacher's most recently created assignment ([] when there is none). */
export function latestSectionsForTeacher(teacherId: string): Section[] {
  const latest = one<{ id: string }>(
    "SELECT id FROM assignments WHERE teacher_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    teacherId,
  );
  return latest ? listSections(latest.id) : [];
}

/** AI usage of one served model, added up over every call. */
export interface ModelUsage extends AiUsage {
  calls: number;
}

/** Every AI call made for the assignment (grading, regrades, retries, key reading), by the model that answered. */
export function getAssignmentUsage(assignmentId: string): Record<string, ModelUsage> {
  const row = one<{ ai_usage_json: string }>("SELECT ai_usage_json FROM assignments WHERE id = ?", assignmentId);
  return row ? (JSON.parse(row.ai_usage_json) as Record<string, ModelUsage>) : {};
}

/** Adds one billed AI call to the assignment's running totals (a no-op when the assignment is gone). */
export function addAssignmentUsage(assignmentId: string, model: string, usage: AiUsage): void {
  tx(() => {
    const ledger = getAssignmentUsage(assignmentId);
    const totals = ledger[model] ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    ledger[model] = {
      calls: totals.calls + 1,
      inputTokens: totals.inputTokens + usage.inputTokens,
      outputTokens: totals.outputTokens + usage.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
    };
    run("UPDATE assignments SET ai_usage_json = ? WHERE id = ?", JSON.stringify(ledger), assignmentId);
  });
}
