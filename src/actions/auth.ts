"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import * as z from "zod";
import { authenticateTeacher, registerTeacher } from "@/lib/auth/accounts";
import { createSession, destroySession } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { attempt } from "@/lib/http/action-result";
import { checkLogin, checkSignup } from "@/lib/http/rate-limit";
import { clientIp } from "@/lib/http/request";
import { formFields, parseInput } from "@/lib/http/validation";
import type { ActionResult } from "@/lib/types";

// Field contents are validated by registerTeacher; these schemas only check that the fields are text.
const SignupFormSchema = z.object({
  displayName: z.string("Enter your name."),
  email: z.string("Enter your email address."),
  password: z.string("Choose a password."),
  code: z.string().optional(),
});

// Bounded so an oversized password never reaches scrypt; any problem is reported like a wrong password.
const LoginFormSchema = z.object({
  email: z.string().max(320),
  password: z.string().max(1000),
});

const INVALID_CREDENTIALS = "Email or password is incorrect.";
const TEACHER_HOME = "/teacher";

export async function signupAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    checkSignup(clientIp(await headers()));
    const input = parseInput(SignupFormSchema, formFields(fd, ["displayName", "email", "password", "code"]));
    const teacher = await registerTeacher({ ...input, code: input.code ?? null });
    await createSession(teacher.id);
  });
  if (!result.ok) return result;
  refresh();
  redirect(TEACHER_HOME);
}

export async function loginAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const fields = formFields(fd, ["email", "password", "next"]);
  const result = await attempt(async () => {
    const input = LoginFormSchema.safeParse(fields);
    if (!input.success) throw new AppError("invalid_credentials", INVALID_CREDENTIALS);
    checkLogin(clientIp(await headers()), input.data.email);
    const teacher = await authenticateTeacher(input.data.email, input.data.password);
    if (!teacher) throw new AppError("invalid_credentials", INVALID_CREDENTIALS);
    await createSession(teacher.id);
  });
  if (!result.ok) return result;
  refresh();
  redirect(safeNext(fields.next));
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  refresh();
  redirect("/login");
}

/**
 * Only teacher pages are valid destinations, which also rules out redirects to other sites. Resolving the
 * path first normalizes "/teacher/../login" and drops control characters that must not reach a header.
 */
function safeNext(next: string | undefined): string {
  if (!next?.startsWith(TEACHER_HOME)) return TEACHER_HOME;
  const url = new URL(next, "http://same-origin.invalid");
  return url.pathname.startsWith(TEACHER_HOME) ? url.pathname + url.search : TEACHER_HOME;
}
