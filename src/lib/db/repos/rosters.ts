import { now } from "@/lib/clock";
import { one, run } from "@/lib/db/sql";

// The class list of an assignment (assignment_rosters): the text the teacher pasted, one student per line.

export function getRosterText(assignmentId: string): string | null {
  return one<{ roster_text: string }>("SELECT roster_text FROM assignment_rosters WHERE assignment_id = ?", assignmentId)?.roster_text ?? null;
}

/** Stores the assignment's class list ("" removes it). */
export function putRosterText(assignmentId: string, text: string): void {
  if (text.trim() === "") {
    run("DELETE FROM assignment_rosters WHERE assignment_id = ?", assignmentId);
    return;
  }
  run(
    `INSERT INTO assignment_rosters (assignment_id, roster_text, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (assignment_id) DO UPDATE SET roster_text = excluded.roster_text, updated_at = excluded.updated_at`,
    assignmentId, text, now(),
  );
}

/** The class list the teacher saved most recently on another of their assignments, for "use the previous list". */
export function latestOtherRoster(teacherId: string, assignmentId: string): { assignmentId: string; title: string; text: string } | null {
  const row = one<{ assignment_id: string; title: string; roster_text: string }>(
    `SELECT r.assignment_id, a.title, r.roster_text FROM assignment_rosters r JOIN assignments a ON a.id = r.assignment_id
     WHERE a.teacher_id = ? AND r.assignment_id <> ? ORDER BY r.updated_at DESC, r.rowid DESC LIMIT 1`,
    teacherId, assignmentId,
  );
  return row ? { assignmentId: row.assignment_id, title: row.title, text: row.roster_text } : null;
}
