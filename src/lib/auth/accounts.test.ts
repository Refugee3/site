import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateTeacher, registerTeacher, signupPolicy } from "@/lib/auth/accounts";
import { resetConfigForTests } from "@/lib/config";
import { countTeachers } from "@/lib/db/repos/teachers";
import { AppError } from "@/lib/errors";
import { seedTeacher, useTestDb } from "@/test/helpers";

const PASSWORD = "a long enough password";

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
    { teachers: 0, code: "letmein", policy: "open_first" },
    { teachers: 1, code: "letmein", policy: "code_required" },
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

  it("requires the configured code after the first teacher", async () => {
    withSignupCode("letmein");
    await signup();

    for (const code of [null, "", "letmeout"]) {
      const error = await rejection(signup({ email: "second@example.com", code }));
      expect(error.code).toBe("bad_signup_code");
      expect(error.extra.fieldErrors).toHaveProperty("code");
    }
    await expect(signup({ email: "second@example.com", code: " letmein " })).resolves.toMatchObject({ email: "second@example.com" });
    expect(countTeachers()).toBe(2);
  });

  it("refuses a taken email, whatever its case", async () => {
    withSignupCode("letmein");
    await signup();
    const error = await rejection(signup({ email: "MARIA@example.com", code: "letmein" }));
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

  it("makes the losing first signup present the code when one is configured", async () => {
    withSignupCode("letmein");
    const results = await Promise.allSettled([signup({ email: "a@example.com" }), signup({ email: "b@example.com" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [failure] = results.filter((r) => r.status === "rejected");
    expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: "bad_signup_code" });
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
