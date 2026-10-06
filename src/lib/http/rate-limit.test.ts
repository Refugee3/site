import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { AppError } from "@/lib/errors";
import {
  checkCodeLookup, checkLogin, checkSignup, checkStudentUpload, hit, resetRateLimitsForTests,
} from "@/lib/http/rate-limit";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
let clock = T0;

beforeEach(() => {
  clock = T0;
  setClockForTests(() => clock);
});

/** Calls `check` `times` times, then returns the AppError of the next call (or null if it passed). */
function refusalAfter(times: number, check: () => void): AppError | null {
  for (let i = 0; i < times; i++) check();
  try {
    check();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
}

describe("hit", () => {
  it("allows `limit` requests per fixed window, then says when the window ends", () => {
    expect(hit("b", 2, 1000, T0)).toEqual({ ok: true });
    expect(hit("b", 2, 1000, T0 + 100)).toEqual({ ok: true });
    expect(hit("b", 2, 1000, T0 + 400)).toEqual({ ok: false, retryAfterMs: 600 });
    expect(hit("b", 2, 1000, T0 + 999)).toEqual({ ok: false, retryAfterMs: 1 });
  });

  it("starts a fresh window once the old one has ended", () => {
    hit("b", 1, 1000, T0);
    expect(hit("b", 1, 1000, T0 + 1000)).toEqual({ ok: true });
    expect(hit("b", 1, 1000, T0 + 1500)).toEqual({ ok: false, retryAfterMs: 500 });
  });

  it("does not count refused requests", () => {
    hit("b", 1, 1000, T0);
    for (let t = 1; t < 1000; t += 100) hit("b", 1, 1000, T0 + t);
    expect(hit("b", 1, 1000, T0 + 1000)).toEqual({ ok: true });
  });

  it("keeps buckets apart", () => {
    hit("a", 1, 1000, T0);
    expect(hit("a", 1, 1000, T0)).toMatchObject({ ok: false });
    expect(hit("b", 1, 1000, T0)).toEqual({ ok: true });
  });

  it("keeps working across pruning, which drops only ended windows", () => {
    hit("short", 1, 1000, T0);
    hit("long", 1, 10 * MINUTE, T0);
    expect(hit("long", 1, 10 * MINUTE, T0 + 2 * MINUTE)).toEqual({ ok: false, retryAfterMs: 8 * MINUTE });
    expect(hit("short", 1, 1000, T0 + 2 * MINUTE)).toEqual({ ok: true });
  });

  it("forgets everything on reset", () => {
    hit("b", 1, 1000, T0);
    resetRateLimitsForTests();
    expect(hit("b", 1, 1000, T0)).toEqual({ ok: true });
  });
});

describe("checkStudentUpload", () => {
  it("allows 60 uploads per IP per 10 minutes", () => {
    const error = refusalAfter(60, () => checkStudentUpload("203.0.113.7", "K7M4QX"));
    expect(error).toMatchObject({ code: "rate_limited", status: 429, extra: { retryAfterMs: 10 * MINUTE } });
    expect(error?.message).toContain("10 minutes");
    expect(() => checkStudentUpload("203.0.113.8", "K7M4QX")).not.toThrow();

    clock += 10 * MINUTE;
    expect(() => checkStudentUpload("203.0.113.7", "K7M4QX")).not.toThrow();
  });

  it("allows 300 uploads per assignment per hour, whatever the IPs", () => {
    let n = 0;
    const error = refusalAfter(300, () => checkStudentUpload(`ip-${n++}`, "K7M4QX"));
    expect(error).toMatchObject({ code: "rate_limited", extra: { retryAfterMs: 60 * MINUTE } });
    expect(() => checkStudentUpload("203.0.113.7", "ABCDEF")).not.toThrow();
  });

  it("allows 1000 anonymous uploads per hour in all", () => {
    let n = 0;
    const error = refusalAfter(1000, () => checkStudentUpload(`ip-${n}`, `CODE${n++ % 4}`));
    expect(error).toMatchObject({ code: "rate_limited" });
  });

  it("puts uploads without an IP in one shared bucket", () => {
    expect(refusalAfter(60, () => checkStudentUpload(null, "K7M4QX"))).toMatchObject({ code: "rate_limited" });
  });

  it("counts a refused upload against no rule at all", () => {
    let n = 0;
    refusalAfter(300, () => checkStudentUpload(`ip-${n++}`, "K7M4QX"));
    for (let i = 0; i < 100; i++) expect(() => checkStudentUpload("203.0.113.7", "K7M4QX")).toThrow(AppError);
    // Those refusals used none of this IP's own allowance.
    expect(refusalAfter(60, () => checkStudentUpload("203.0.113.7", "ABCDEF"))).toMatchObject({ code: "rate_limited" });
  });
});

describe("checkLogin", () => {
  it("allows 10 attempts per email per 15 minutes, from any IP and in any spelling", () => {
    let n = 0;
    const spellings = ["maria@example.com", " Maria@Example.com "];
    const error = refusalAfter(10, () => checkLogin(`ip-${n}`, spellings[n++ % 2]));
    expect(error).toMatchObject({ code: "rate_limited", extra: { retryAfterMs: 15 * MINUTE } });
    expect(() => checkLogin("ip-x", "other@example.com")).not.toThrow();
  });

  it("allows 30 attempts per IP per 15 minutes", () => {
    let n = 0;
    expect(refusalAfter(30, () => checkLogin("203.0.113.7", `user${n++}@example.com`))).toMatchObject({ code: "rate_limited" });
  });
});

describe("checkSignup and checkCodeLookup", () => {
  it("allow 5 signups per IP per hour", () => {
    expect(refusalAfter(5, () => checkSignup("203.0.113.7"))).toMatchObject({ extra: { retryAfterMs: 60 * MINUTE } });
    expect(() => checkSignup("203.0.113.8")).not.toThrow();
  });

  it("allow 60 code lookups per IP per minute", () => {
    const error = refusalAfter(60, () => checkCodeLookup("203.0.113.7"));
    expect(error).toMatchObject({ extra: { retryAfterMs: MINUTE } });
    expect(error?.message).toContain("1 minute.");
  });
});
