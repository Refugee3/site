import { now } from "@/lib/clock";
import { isUniqueViolation, one, run } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import type { Teacher } from "@/lib/types";

export interface TeacherRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: number;
}

export function teacherFromRow(row: TeacherRow): Teacher {
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
}

export function countTeachers(): number {
  return one<{ n: number }>("SELECT count(*) AS n FROM teachers")!.n;
}

/** Throws AppError("conflict") when the email is taken (emails compare case-insensitively). */
export function insertTeacher(t: { email: string; displayName: string; passwordHash: string }): Teacher {
  try {
    const row = one<TeacherRow>(
      `INSERT INTO teachers (id, email, display_name, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
      newId(), t.email, t.displayName, t.passwordHash, now(),
    );
    return teacherFromRow(row!);
  } catch (error) {
    if (isUniqueViolation(error, "teachers.email")) {
      throw new AppError("conflict", "An account with this email already exists.", { fieldErrors: { email: ["An account with this email already exists."] } });
    }
    throw error;
  }
}

export function findTeacherAuthByEmail(email: string): { teacher: Teacher; passwordHash: string } | null {
  const row = one<TeacherRow>("SELECT * FROM teachers WHERE email = ?", email);
  return row ? { teacher: teacherFromRow(row), passwordHash: row.password_hash } : null;
}

export function getTeacher(id: string): Teacher | null {
  const row = one<TeacherRow>("SELECT * FROM teachers WHERE id = ?", id);
  return row ? teacherFromRow(row) : null;
}

/** "" when the teacher has none (or is unknown). */
export function getGradingPreferences(teacherId: string): string {
  return one<{ grading_preferences: string }>("SELECT grading_preferences FROM teachers WHERE id = ?", teacherId)?.grading_preferences ?? "";
}

export function setGradingPreferences(teacherId: string, text: string): void {
  run("UPDATE teachers SET grading_preferences = ? WHERE id = ?", text, teacherId);
}
