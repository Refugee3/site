import { describe, expect, it } from "vitest";
import { DUMMY_HASH, hashLoadForTests, hashPassword, verifyPassword } from "@/lib/auth/password";

const STORED_FORMAT = /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;

describe("hashPassword / verifyPassword", () => {
  it("stores scrypt parameters, a 16-byte salt and a 64-byte hash as base64url", async () => {
    expect(await hashPassword("correct horse battery")).toMatch(STORED_FORMAT);
  });

  it("round-trips the right password and rejects any other", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password"), hashPassword("same password")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("never matches a malformed stored value", async () => {
    const stored = await hashPassword("correct horse battery");
    for (const bad of ["", "scrypt$test$not-a-real-hash", stored.replace("scrypt$", "bcrypt$"), stored.slice(0, -4)]) {
      expect(await verifyPassword("correct horse battery", bad)).toBe(false);
    }
  });

  it("has a well-formed dummy hash, so unknown emails cost a full scrypt check", async () => {
    expect(DUMMY_HASH).toMatch(STORED_FORMAT);
    expect(await verifyPassword("correct horse battery", DUMMY_HASH)).toBe(false);
  });
});

describe("scrypt concurrency", () => {
  it("runs at most 2 hashes at once and refuses at once when 32 are already waiting", async () => {
    const calls = Array.from({ length: 40 }, () => verifyPassword("a guess", DUMMY_HASH).then(
      (valid) => ({ valid }),
      (e: unknown) => ({ error: e }),
    ));
    expect(hashLoadForTests()).toEqual({ active: 2, waiting: 32 });

    const results = await Promise.all(calls);
    expect(results.filter((r) => "valid" in r && r.valid === false)).toHaveLength(34);
    const refused = results.filter((r) => "error" in r);
    expect(refused).toHaveLength(6);
    for (const r of refused) expect((r as { error: unknown }).error).toMatchObject({ code: "rate_limited" });
    expect(hashLoadForTests()).toEqual({ active: 0, waiting: 0 });
  });
});
