import { timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { countTeachers, findTeacherAuthByEmail, insertTeacher } from "@/lib/db/repos/teachers";
import { AppError } from "@/lib/errors";
import { sha256Hex } from "@/lib/ids";
import { DUMMY_HASH, hashPassword, verifyPassword } from "@/lib/auth/password";
import { parseInput } from "@/lib/http/validation";
import type { Teacher } from "@/lib/types";

export type SignupPolicy = "open_first" | "code_required" | "closed";

const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().max(254, "Use at most 254 characters.").pipe(z.email("Enter a valid email address.")),
  displayName: z.string().trim().min(1, "Enter your name.").max(100, "Use at most 100 characters."),
  password: z.string().min(10, "Use at least 10 characters.").max(200, "Use at most 200 characters."),
  code: z.string().trim().nullable(),
});

/** The first teacher signs up freely; everyone after needs TEACHER_SIGNUP_CODE, and without one signups are closed. */
export function signupPolicy(): SignupPolicy {
  if (countTeachers() === 0) return "open_first";
  return getConfig().teacherSignupCode !== null ? "code_required" : "closed";
}

/**
 * Creates a teacher account. The policy is checked again inside the transaction that inserts, so two
 * simultaneous "first teacher" signups cannot both skip the code.
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

/** The teacher for these credentials, or null. Unknown emails still pay for a hash check (against DUMMY_HASH). */
export async function authenticateTeacher(email: string, password: string): Promise<Teacher | null> {
  const account = findTeacherAuthByEmail(email.trim().toLowerCase());
  const valid = await verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
  return account && valid ? account.teacher : null;
}
