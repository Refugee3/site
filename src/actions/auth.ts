"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import * as z from "zod";
import { logInTeacher, signUpTeacher } from "@/lib/auth/accounts";
import { safeNextPath, TEACHER_HOME } from "@/lib/auth/next-path";
import { createSession, destroySession } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { attempt } from "@/lib/http/action-result";
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

export async function signupAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    const ip = clientIp(await headers());
    const input = parseInput(SignupFormSchema, formFields(fd, ["displayName", "email", "password", "code"]));
    const teacher = await signUpTeacher(ip, { ...input, code: input.code ?? null });
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
    const teacher = await logInTeacher(clientIp(await headers()), input.data.email, input.data.password);
    if (!teacher) throw new AppError("invalid_credentials", INVALID_CREDENTIALS);
    await createSession(teacher.id);
  });
  if (!result.ok) return result;
  refresh();
  redirect(safeNextPath(fields.next));
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  refresh();
  redirect("/login");
}
