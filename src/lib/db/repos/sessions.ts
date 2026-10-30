import { now } from "@/lib/clock";
import { one, run } from "@/lib/db/sql";
import { teacherFromRow, type TeacherRow } from "@/lib/db/repos/teachers";
import type { Teacher } from "@/lib/types";

export function insertSession(s: { tokenHash: string; teacherId: string; expiresAt: number }): void {
  run(
    "INSERT INTO sessions (token_hash, teacher_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    s.tokenHash, s.teacherId, now(), s.expiresAt,
  );
}

/** The teacher behind an unexpired session, or null. */
export function findSessionTeacher(tokenHash: string, at: number): Teacher | null {
  const row = one<TeacherRow>(
    `SELECT t.* FROM sessions s JOIN teachers t ON t.id = s.teacher_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash, at,
  );
  return row ? teacherFromRow(row) : null;
}

export function deleteSession(tokenHash: string): void {
  run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
}

export function deleteExpiredSessions(at: number): number {
  return run("DELETE FROM sessions WHERE expires_at <= ?", at);
}
