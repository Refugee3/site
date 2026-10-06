import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { now } from "@/lib/clock";
import { getAssignmentForTeacher } from "@/lib/db/repos/assignments";
import { findSessionTeacher } from "@/lib/db/repos/sessions";
import { getSubmissionForTeacher } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { isId } from "@/lib/ids";
import { SESSION_COOKIE, sessionTokenHash } from "@/lib/auth/session";
import type { Assignment, Submission, Teacher } from "@/lib/types";

// The data access layer is the auth boundary (authentication.md): every teacher page, action and route
// handler goes through it, because layouts are not re-checked on navigation and there is no proxy.

/** The signed-in teacher, looked up once per request. */
export const getCurrentTeacher = cache(async (): Promise<Teacher | null> => {
  const hash = sessionTokenHash((await cookies()).get(SESSION_COOKIE)?.value);
  return hash ? findSessionTeacher(hash, now()) : null;
});

// ---------------------------------------------------------------------------------------------
// Pages and server actions: redirect() to log in, notFound() for anything not the teacher's own.

export async function requireTeacher(): Promise<Teacher> {
  return (await getCurrentTeacher()) ?? redirect("/login");
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
