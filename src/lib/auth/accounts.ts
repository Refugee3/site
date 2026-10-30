import { timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { countTeachers, findTeacherAuthByEmail, insertTeacher } from "@/lib/db/repos/teachers";
import { AppError, isAppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/ids";
import { DUMMY_HASH, hashPassword, verifyPassword } from "@/lib/auth/password";
import { checkLogin, checkSignup } from "@/lib/http/rate-limit";
import { parseInput } from "@/lib/http/validation";
import type { Teacher } from "@/lib/types";

export type SignupPolicy = "open_first" | "code_required" | "closed";

const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().max(254, "Use at most 254 characters.").pipe(z.email("Enter a valid email address.")),
  displayName: z.string().trim().min(1, "Enter your name.").max(100, "Use at most 100 characters."),
  password: z.string().min(10, "Use at least 10 characters.").max(200, "Use at most 200 characters."),
  code: z.string().trim().nullable(),
});

/**
 * With TEACHER_SIGNUP_CODE set, every signup needs it, the first one included. Without it, only the first
 * teacher can sign up and signups are closed after that.
 */
export function signupPolicy(): SignupPolicy {
  if (getConfig().teacherSignupCode !== null) return "code_required";
  return countTeachers() === 0 ? "open_first" : "closed";
}

/** True until the first teacher account exists. */
export function isFirstSignup(): boolean {
  return countTeachers() === 0;
}

/**
 * `registerTeacher` behind the signup limits (`checkSignup`, by the caller's IP): only an attempt that
 * fails on a wrong signup code uses up the server-wide budget of code guesses.
 */
export async function signUpTeacher(
  ip: string | null,
  i: { email: string; displayName: string; password: string; code: string | null },
): Promise<Teacher> {
  const codeGuess = checkSignup(ip);
  try {
    const teacher = await registerTeacher(i);
    codeGuess.refund();
    return teacher;
  } catch (e) {
    if (!isAppError(e) || e.code !== "bad_signup_code") codeGuess.refund();
    throw e;
  }
}

/**
 * Creates a teacher account. The policy is checked again inside the transaction that inserts, so two
 * simultaneous "first teacher" signups (no code configured) cannot both get in.
 */
export async function registerTeacher(i: { email: string; displayName: string; password: string; code: string | null }): Promise<Teacher> {
  const input = parseInput(SignupSchema, i);
  assertMaySignUp(input.code); // fail fast, before the deliberately slow hash
  const passwordHash = await hashPassword(input.password);
  return tx(() => {
    assertMaySignUp(input.code);
    return insertTeacher({ email: input.email, displayName: input.displayName, passwordHash });
  });
}

function assertMaySignUp(code: string | null): void {
  const policy = signupPolicy();
  if (policy === "closed") throw new AppError("signup_closed", "Sign-ups are closed on this server.");
  if (policy === "code_required" && !matchesSignupCode(code)) {
    const message = "That signup code is not correct.";
    throw new AppError("bad_signup_code", message, { fieldErrors: { code: [message] } });
  }
}

/** Compares digests so the comparison takes the same time whatever the input's length. */
function matchesSignupCode(code: string | null): boolean {
  const expected = getConfig().teacherSignupCode;
  if (!code || expected === null) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(code)), Buffer.from(sha256Hex(expected)));
}

/**
 * `authenticateTeacher` behind the login limits (`checkLogin`, by the caller's IP). The attempt is counted
 * before the slow check, so a burst of concurrent guesses cannot all slip past, and given back unless the
 * credentials are wrong: only failures use up the limits.
 */
export async function logInTeacher(ip: string | null, email: string, password: string): Promise<Teacher | null> {
  const loginAttempt = checkLogin(ip, email);
  let teacher: Teacher | null;
  try {
    teacher = await authenticateTeacher(email, password);
  } catch (e) {
    loginAttempt.refund();
    throw e;
  }
  if (teacher) loginAttempt.refund();
  return teacher;
}

/** The teacher for these credentials, or null. Unknown emails still pay for a hash check (against DUMMY_HASH). */
export async function authenticateTeacher(email: string, password: string): Promise<Teacher | null> {
  const account = findTeacherAuthByEmail(email.trim().toLowerCase());
  const valid = await verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
  return account && valid ? account.teacher : null;
}
