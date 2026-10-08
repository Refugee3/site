import { now } from "@/lib/clock";
import { tx } from "@/lib/db/connection";
import { all, encodePatch, one, run, toBit, updateRow, type ColumnMap } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { AiUsage, Assignment, AssignmentKind, AssignmentStatus, GradingMode, Section } from "@/lib/types";

interface AssignmentRow {
  id: string;
  teacher_id: string;
  title: string;
  kind: AssignmentKind;
  instructions: string;
  write_notes: 0 | 1;
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
    kind: row.kind,
    instructions: row.instructions,
    writeNotes: row.write_notes === 1,
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
  a: Pick<Assignment, "id" | "teacherId" | "title" | "instructions" | "gradingMode" | "accuracyWeight" | "shareCode" | "maxSubmissions">
    & Partial<Pick<Assignment, "kind" | "writeNotes">>,
): Assignment {
  const at = now();
  const row = one<AssignmentRow>(
    `INSERT INTO assignments (id, teacher_id, title, kind, instructions, write_notes, grading_mode, accuracy_weight, share_code, max_submissions,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    a.id, a.teacherId, a.title, a.kind ?? "homework", a.instructions, toBit(a.writeNotes ?? false), a.gradingMode, a.accuracyWeight, a.shareCode, a.maxSubmissions, at, at,
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

/** Open assignments of every teacher: they take student uploads whenever the app-wide switch is on. */
export function countOpenAssignments(): number {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM assignments WHERE status = 'open'")!.n;
}

type AssignmentPatch = Pick<Assignment, "title" | "kind" | "instructions" | "writeNotes" | "status" | "gradingMode" | "accuracyWeight" | "shareCode"
  | "maxSubmissions" | "feedbackReleasedAt">;

const ASSIGNMENT_COLUMNS: ColumnMap<AssignmentPatch> = {
  title: "title",
  kind: "kind",
  instructions: "instructions",
  writeNotes: ["write_notes", toBit],
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

/** The part of a model's totals that hosted-agent sessions used. */
export interface AgentUsageTotals {
  sessions: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  /** Sum of the reported list costs, in US cents. */
  listCostCents: number;
  /** Sessions that reported no list cost (cost tracking unavailable); their cost is estimated from tokens + time. */
  unpricedSessions: number;
  activeSeconds: number;
}

/** AI usage of one served model, added up over every call; `agent` is present once a hosted-agent session was added. */
export interface ModelUsage extends AiUsage {
  calls: number;
  agent?: AgentUsageTotals;
}

/** Every AI call made for the assignment (grading, regrades, retries, key reading), by the model that answered. */
export function getAssignmentUsage(assignmentId: string): Record<string, ModelUsage> {
  const row = one<{ ai_usage_json: string }>("SELECT ai_usage_json FROM assignments WHERE id = ?", assignmentId);
  return row ? (JSON.parse(row.ai_usage_json) as Record<string, ModelUsage>) : {};
}

function addTokens(totals: AiUsage, usage: AiUsage): AiUsage {
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
  };
}

const NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const NO_AGENT_USAGE: AgentUsageTotals = { sessions: 0, ...NO_USAGE, listCostCents: 0, unpricedSessions: 0, activeSeconds: 0 };

function addAgentSession(
  totals: AgentUsageTotals,
  usage: AiUsage,
  agent: { listCostCents: number | null; activeSeconds: number },
): AgentUsageTotals {
  return {
    sessions: totals.sessions + 1,
    ...addTokens(totals, usage),
    listCostCents: totals.listCostCents + (agent.listCostCents ?? 0),
    unpricedSessions: totals.unpricedSessions + (agent.listCostCents === null ? 1 : 0),
    activeSeconds: totals.activeSeconds + agent.activeSeconds,
  };
}

/**
 * Adds one billed AI call to the assignment's running totals (a no-op when the assignment is gone). `agent` is given for
 * hosted-agent sessions: the call's tokens are added to the model's totals as before, and also to `agent`, with its list
 * cost and running time.
 */
export function addAssignmentUsage(
  assignmentId: string,
  model: string,
  usage: AiUsage,
  agent?: { listCostCents: number | null; activeSeconds: number },
): void {
  tx(() => {
    const ledger = getAssignmentUsage(assignmentId);
    const totals: ModelUsage = ledger[model] ?? { calls: 0, ...NO_USAGE };
    const entry: ModelUsage = { calls: totals.calls + 1, ...addTokens(totals, usage) };
    const agentTotals = agent ? addAgentSession(totals.agent ?? NO_AGENT_USAGE, usage, agent) : totals.agent;
    if (agentTotals) entry.agent = agentTotals;
    ledger[model] = entry;
    run("UPDATE assignments SET ai_usage_json = ? WHERE id = ?", JSON.stringify(ledger), assignmentId);
  });
}

// ---------------------------------------------------------------------------------------------
// The grading batch: papers queued since the assignment's queue last became non-empty (progress bars)

/** A scan of the assignment is being graded in one pass: its papers belong to the current batch as they are graded. */
const ONE_PASS_RUNNING = `EXISTS (SELECT 1 FROM scans sc WHERE sc.assignment_id = @aid AND sc.status = 'splitting'
  AND sc.split_mode = 'one_pass')`;

/**
 * Called when `submissionId` (already queued) gets its grading job. Starts a new batch when no other paper of the assignment
 * is queued or being graded and no scan of it is being graded in one pass (or none was recorded): the batch then starts when
 * the oldest paper waiting now was queued.
 */
export function startGradingBatchIfIdle(assignmentId: string, submissionId: string): void {
  run(
    `UPDATE assignments SET batch_started_at = (
       SELECT min(s.queued_at) FROM submissions s WHERE s.assignment_id = @aid AND s.status IN ('queued', 'grading'))
     WHERE id = @aid AND (batch_started_at IS NULL OR (NOT EXISTS (
       SELECT 1 FROM submissions s WHERE s.assignment_id = @aid AND s.status IN ('queued', 'grading') AND s.id <> @sid)
       AND NOT ${ONE_PASS_RUNNING}))`,
    { aid: assignmentId, sid: submissionId },
  );
}

/**
 * A scan's grading in one pass starts (or resumes) at `at`: it starts a batch then unless one is running, so the papers it
 * grades (stored already graded) count in the batch.
 */
export function startGradingBatchForOnePass(assignmentId: string, at: number): void {
  run(
    `UPDATE assignments SET batch_started_at = @at
     WHERE id = @aid AND batch_started_at IS NULL`,
    { aid: assignmentId, at },
  );
}

/** Ends the batch once none of the assignment's papers is queued or being graded and no scan of it is graded in one pass. */
export function clearGradingBatchIfDrained(assignmentId: string): void {
  run(
    `UPDATE assignments SET batch_started_at = NULL
     WHERE id = @aid AND batch_started_at IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM submissions s WHERE s.assignment_id = @aid AND s.status IN ('queued', 'grading'))
       AND NOT ${ONE_PASS_RUNNING}`,
    { aid: assignmentId },
  );
}

/** When the assignment's current grading batch started; null when none is recorded. */
export function getGradingBatchStartedAt(assignmentId: string): number | null {
  return one<{ batch_started_at: number | null }>("SELECT batch_started_at FROM assignments WHERE id = ?", assignmentId)
    ?.batch_started_at ?? null;
}
