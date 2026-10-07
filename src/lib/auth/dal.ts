import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { now } from "@/lib/clock";
import { getAssignmentForTeacher } from "@/lib/db/repos/assignments";
import { getLessonForTeacher } from "@/lib/db/repos/lessons";
import { getScanForTeacher } from "@/lib/db/repos/scans";
import { findSessionTeacher } from "@/lib/db/repos/sessions";
import { getSubmissionForTeacher } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { isId } from "@/lib/ids";
import { RETURN_TO_HEADER, safeNextPath, TEACHER_HOME } from "@/lib/auth/next-path";
import { SESSION_COOKIE, sessionTokenHash } from "@/lib/auth/session";
import type { Assignment, Lesson, Scan, Submission, Teacher } from "@/lib/types";

// The data access layer is the auth boundary (authentication.md): every teacher page, action and route
// handler goes through it, because layouts are not re-checked on navigation. src/proxy.ts checks nothing;
// it only passes the requested teacher page along, for the way back after logging in.

/** The signed-in teacher, looked up once per request. */
export const getCurrentTeacher = cache(async (): Promise<Teacher | null> => {
  const hash = sessionTokenHash((await cookies()).get(SESSION_COOKIE)?.value);
  return hash ? findSessionTeacher(hash, now()) : null;
});

// ---------------------------------------------------------------------------------------------
// Pages and server actions: redirect() to log in, notFound() for anything not the teacher's own.

/** Without a session, redirects to /login?next=<the teacher page asked for>, so logging in leads back there. */
export async function requireTeacher(): Promise<Teacher> {
  const teacher = await getCurrentTeacher();
  if (teacher) return teacher;
  const back = safeNextPath((await headers()).get(RETURN_TO_HEADER));
  redirect(back === TEACHER_HOME ? "/login" : `/login?next=${encodeURIComponent(back)}`);
}

export async function requireOwnedAssignment(id: string): Promise<{ teacher: Teacher; assignment: Assignment }> {
  const teacher = await requireTeacher();
  const assignment = findOwnedAssignment(id, teacher) ?? notFound();
  return { teacher, assignment };
}

export async function requireOwnedSubmission(id: string): Promise<{ teacher: Teacher; assignment: Assignment; submission: Submission }> {
  const teacher = await requireTeacher();
  const owned = findOwnedSubmission(id, teacher) ?? notFound();
  return { teacher, ...owned };
}

export async function requireOwnedLesson(id: string): Promise<{ teacher: Teacher; assignment: Assignment; lesson: Lesson }> {
  const teacher = await requireTeacher();
  const owned = findOwnedLesson(id, teacher) ?? notFound();
  return { teacher, ...owned };
}

export async function requireOwnedScan(id: string): Promise<{ teacher: Teacher; assignment: Assignment; scan: Scan }> {
  const teacher = await requireTeacher();
  const owned = findOwnedScan(id, teacher) ?? notFound();
  return { teacher, ...owned };
}

// ---------------------------------------------------------------------------------------------
// Route handlers: they answer with JSON errors (401, 404) and never redirect.

export async function routeTeacher(): Promise<Teacher | null> {
  return getCurrentTeacher();
}

/** The signed-in teacher, else AppError("unauthorized"). */
export async function requireRouteTeacher(): Promise<Teacher> {
  const teacher = await routeTeacher();
  if (!teacher) throw new AppError("unauthorized", "Log in to continue.");
  return teacher;
}

/** "Not yours" and "doesn't exist" are both 404, so ids reveal nothing. */
export function ownedAssignmentOr404(id: string, teacher: Teacher): Assignment {
  const assignment = findOwnedAssignment(id, teacher);
  if (!assignment) throw notFoundError();
  return assignment;
}

export function ownedSubmissionOr404(id: string, teacher: Teacher): { assignment: Assignment; submission: Submission } {
  const owned = findOwnedSubmission(id, teacher);
  if (!owned) throw notFoundError();
  return owned;
}

export function ownedScanOr404(id: string, teacher: Teacher): { assignment: Assignment; scan: Scan } {
  const owned = findOwnedScan(id, teacher);
  if (!owned) throw notFoundError();
  return owned;
}

function notFoundError(): AppError {
  return new AppError("not_found", "Not found.");
}

// Ids come from URLs and action arguments, so they are checked before any query.

function findOwnedAssignment(id: string, teacher: Teacher): Assignment | null {
  return typeof id === "string" && isId(id) ? getAssignmentForTeacher(id, teacher.id) : null;
}

function findOwnedSubmission(id: string, teacher: Teacher): { assignment: Assignment; submission: Submission } | null {
  return typeof id === "string" && isId(id) ? getSubmissionForTeacher(id, teacher.id) : null;
}

function findOwnedLesson(id: string, teacher: Teacher): { assignment: Assignment; lesson: Lesson } | null {
  return typeof id === "string" && isId(id) ? getLessonForTeacher(id, teacher.id) : null;
}

function findOwnedScan(id: string, teacher: Teacher): { assignment: Assignment; scan: Scan } | null {
  return typeof id === "string" && isId(id) ? getScanForTeacher(id, teacher.id) : null;
}
