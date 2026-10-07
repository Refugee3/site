import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateTeacher, isFirstSignup, logInTeacher, registerTeacher, signupPolicy, signUpTeacher } from "@/lib/auth/accounts";
import { resetConfigForTests } from "@/lib/config";
import { countTeachers } from "@/lib/db/repos/teachers";
import { AppError } from "@/lib/errors";
import { seedTeacher, useTestDb } from "@/test/helpers";

const PASSWORD = "a long enough password";
const CODE = "maple-quartz-4417";

function withSignupCode(code: string): void {
  vi.stubEnv("TEACHER_SIGNUP_CODE", code); // "" counts as unset
  resetConfigForTests();
}

function signup(o: Partial<Parameters<typeof registerTeacher>[0]> = {}) {
  return registerTeacher({ email: "maria@example.com", displayName: "Maria Lopez", password: PASSWORD, code: null, ...o });
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

beforeEach(() => {
  useTestDb();
  withSignupCode("");
});

describe("signupPolicy", () => {
  it.each([
    { teachers: 0, code: "", policy: "open_first" },
    { teachers: 0, code: CODE, policy: "code_required" },
    { teachers: 1, code: CODE, policy: "code_required" },
    { teachers: 1, code: "", policy: "closed" },
  ])("$teachers teacher(s), code '$code' → $policy", ({ teachers, code, policy }) => {
    withSignupCode(code);
    for (let i = 0; i < teachers; i++) seedTeacher();
    expect(signupPolicy()).toBe(policy);
  });
});

describe("registerTeacher", () => {
  it("lets the first teacher in without a code, with a normalized email and a hashed password", async () => {
    const teacher = await signup({ email: "  Maria@Example.COM ", displayName: "  Maria Lopez " });
    expect(teacher).toMatchObject({ email: "maria@example.com", displayName: "Maria Lopez" });
    expect(await authenticateTeacher("maria@example.com", PASSWORD)).toEqual(teacher);
  });

  it("closes signups after the first teacher when no code is configured", async () => {
    await signup();
    expect((await rejection(signup({ email: "second@example.com" }))).code).toBe("signup_closed");
  });

  it("requires the configured code for the first teacher too", async () => {
    withSignupCode(CODE);
    expect(isFirstSignup()).toBe(true);
    for (const code of [null, "", "maple-quartz-4418"]) {
      const error = await rejection(signup({ code }));
      expect(error.code).toBe("bad_signup_code");
    }
    expect(countTeachers()).toBe(0);
    await expect(signup({ code: CODE })).resolves.toMatchObject({ email: "maria@example.com" });
    expect(isFirstSignup()).toBe(false);
  });

  it("requires the configured code after the first teacher", async () => {
    withSignupCode(CODE);
    await signup({ code: CODE });

    for (const code of [null, "", "maple-quartz-4418"]) {
      const error = await rejection(signup({ email: "second@example.com", code }));
      expect(error.code).toBe("bad_signup_code");
      expect(error.extra.fieldErrors).toHaveProperty("code");
    }
    await expect(signup({ email: "second@example.com", code: ` ${CODE} ` })).resolves.toMatchObject({ email: "second@example.com" });
    expect(countTeachers()).toBe(2);
  });

  it("refuses a taken email, whatever its case", async () => {
    withSignupCode(CODE);
    await signup({ code: CODE });
    const error = await rejection(signup({ email: "MARIA@example.com", code: CODE }));
    expect(error.code).toBe("conflict");
  });

  it("reports invalid fields by name", async () => {
    const error = await rejection(signup({ email: "not-an-email", displayName: "   ", password: "short" }));
    expect(error.code).toBe("validation");
    expect(Object.keys(error.extra.fieldErrors ?? {}).sort()).toEqual(["displayName", "email", "password"]);
    expect(countTeachers()).toBe(0);
  });

  it("lets only one of two simultaneous first signups skip the code", async () => {
    const results = await Promise.allSettled([signup({ email: "a@example.com" }), signup({ email: "b@example.com" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [failure] = results.filter((r) => r.status === "rejected");
    expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: "signup_closed" });
    expect(countTeachers()).toBe(1);
  });

  it("makes each of two simultaneous first signups present the code when one is configured", async () => {
    withSignupCode(CODE);
    const results = await Promise.allSettled([signup({ email: "a@example.com", code: CODE }), signup({ email: "b@example.com" })]);
    expect(results[0].status).toBe("fulfilled");
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "bad_signup_code" });
    expect(countTeachers()).toBe(1);
  });
});

describe("authenticateTeacher", () => {
  it("returns the teacher only for the right password", async () => {
    const teacher = await signup();
    expect(await authenticateTeacher(" MARIA@example.com ", PASSWORD)).toEqual(teacher);
    expect(await authenticateTeacher("maria@example.com", "a wrong password")).toBeNull();
  });

  it("returns null for an unknown email", async () => {
    await signup();
    expect(await authenticateTeacher("nobody@example.com", PASSWORD)).toBeNull();
  });
});

describe("signUpTeacher", () => {
  it("counts only wrong signup codes against the server-wide budget of 20 per hour, whatever the IPs", async () => {
    withSignupCode(CODE);
    for (let i = 0; i < 20; i++) {
      const error = await rejection(signUpTeacher(`10.0.0.${i}`, { email: "x@example.com", displayName: "X", password: PASSWORD, code: `guess-number-${i}` }));
      expect(error.code).toBe("bad_signup_code");
    }
    const refused = await rejection(signUpTeacher("10.0.1.1", { email: "maria@example.com", displayName: "Maria", password: PASSWORD, code: CODE }));
    expect(refused.code).toBe("rate_limited");
    expect(countTeachers()).toBe(0);
  });

  it("does not count successful signups or other failures as code guesses", async () => {
    withSignupCode(CODE);
    for (let i = 0; i < 25; i++) {
      const error = await rejection(signUpTeacher(`10.0.0.${i}`, { email: "not-an-email", displayName: "X", password: PASSWORD, code: CODE }));
      expect(error.code).toBe("validation");
    }
    await expect(signUpTeacher("10.0.1.1", { email: "maria@example.com", displayName: "Maria", password: PASSWORD, code: CODE }))
      .resolves.toMatchObject({ email: "maria@example.com" });
  });
});

describe("logInTeacher", () => {
  const WRONG = "not the password";

  it("does not let failures from another address lock the teacher out", async () => {
    const teacher = await signup();
    for (let i = 0; i < 10; i++) expect(await logInTeacher("6.6.6.6", "maria@example.com", WRONG)).toBeNull();
    expect((await rejection(logInTeacher("6.6.6.6", "maria@example.com", PASSWORD))).code).toBe("rate_limited");
    expect(await logInTeacher("1.2.3.4", "Maria@Example.com", PASSWORD)).toEqual(teacher);
  });

  it("does not count successful logins", async () => {
    const teacher = await signup();
    for (let i = 0; i < 12; i++) expect(await logInTeacher("1.2.3.4", "maria@example.com", PASSWORD)).toEqual(teacher);
    for (let i = 0; i < 10; i++) expect(await logInTeacher("1.2.3.4", "maria@example.com", WRONG)).toBeNull();
    expect((await rejection(logInTeacher("1.2.3.4", "maria@example.com", PASSWORD))).code).toBe("rate_limited");
  });
});
