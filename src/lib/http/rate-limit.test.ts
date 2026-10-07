import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { AppError } from "@/lib/errors";
import {
  checkCodeLookup, checkLogin, checkSignup, checkStudentUpload, countCodeLookupMiss, countStudentSubmission, hit,
  resetRateLimitsForTests,
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

/** Calls `check` until it refuses, at most `max` times; returns how many calls passed. */
function passesBeforeRefusal(check: () => void, max = 10_000): number {
  for (let n = 0; n < max; n++) {
    try {
      check();
    } catch (e) {
      expect(e).toMatchObject({ code: "rate_limited" });
      return n;
    }
  }
  return max;
}

describe("checkCodeLookup and countCodeLookupMiss", () => {
  it("count only misses: successful lookups from one address never trip the limit", () => {
    for (let i = 0; i < 500; i++) checkCodeLookup("203.0.113.7");
    expect(() => checkCodeLookup("203.0.113.7")).not.toThrow();
  });

  it("refuse every lookup from an address after 60 misses in a minute, then forget them", () => {
    for (let i = 0; i < 59; i++) countCodeLookupMiss("203.0.113.7");
    expect(() => checkCodeLookup("203.0.113.7")).not.toThrow();
    countCodeLookupMiss("203.0.113.7");
    const error = refusalAfter(0, () => checkCodeLookup("203.0.113.7"));
    expect(error).toMatchObject({ code: "rate_limited", extra: { retryAfterMs: MINUTE } });
    expect(error?.message).toContain("1 minute.");
    expect(() => checkCodeLookup("203.0.113.8")).not.toThrow();

    clock += MINUTE;
    expect(() => checkCodeLookup("203.0.113.7")).not.toThrow();
  });

  it("put lookups without an IP in one shared bucket", () => {
    for (let i = 0; i < 60; i++) countCodeLookupMiss(null);
    expect(() => checkCodeLookup(null)).toThrow(AppError);
  });
});

describe("checkStudentUpload and countStudentSubmission", () => {
  it("allow 120 uploads per address and assignment per 10 minutes (one class behind one NAT)", () => {
    const error = refusalAfter(120, () => checkStudentUpload("203.0.113.7", "K7M4QX"));
    expect(error).toMatchObject({ code: "rate_limited", status: 429, extra: { retryAfterMs: 10 * MINUTE } });
    expect(error?.message).toContain("10 minutes");
    expect(() => checkStudentUpload("203.0.113.7", "ABCDEF")).not.toThrow();
    expect(() => checkStudentUpload("203.0.113.8", "K7M4QX")).not.toThrow();

    clock += 10 * MINUTE;
    expect(() => checkStudentUpload("203.0.113.7", "K7M4QX")).not.toThrow();
  });

  it("allow 300 uploads per address per 10 minutes over all assignments (several classes behind one NAT)", () => {
    let n = 0;
    expect(passesBeforeRefusal(() => checkStudentUpload("203.0.113.7", `CODE${n++ % 5}`))).toBe(300);
    expect(() => checkStudentUpload("203.0.113.8", "CODE0")).not.toThrow();
  });

  it("do not charge the shared budgets for uploads that create no submission", () => {
    let n = 0;
    for (let i = 0; i < 2000; i++) checkStudentUpload(`ip-${n++}`, "K7M4QX");
    expect(() => checkStudentUpload("203.0.113.7", "K7M4QX")).not.toThrow();
  });

  it("allow 300 new submissions per assignment per hour, whatever the addresses, and refuse before reading", () => {
    for (let i = 0; i < 299; i++) countStudentSubmission("K7M4QX");
    expect(() => checkStudentUpload("203.0.113.7", "K7M4QX")).not.toThrow();
    countStudentSubmission("K7M4QX");
    expect(refusalAfter(0, () => checkStudentUpload("203.0.113.9", "K7M4QX")))
      .toMatchObject({ code: "rate_limited", extra: { retryAfterMs: 60 * MINUTE } });
    expect(() => checkStudentUpload("203.0.113.9", "ABCDEF")).not.toThrow();
  });

  it("allow 1000 new submissions per hour in all", () => {
    for (let i = 0; i < 1000; i++) countStudentSubmission(`CODE${i % 4}`);
    expect(refusalAfter(0, () => checkStudentUpload("203.0.113.7", "OTHER1"))).toMatchObject({ code: "rate_limited" });
  });

  it("count a refused upload against no rule at all", () => {
    for (let i = 0; i < 300; i++) countStudentSubmission("K7M4QX");
    for (let i = 0; i < 200; i++) expect(() => checkStudentUpload("203.0.113.7", "K7M4QX")).toThrow(AppError);
    // Those refusals used none of this address's own allowance.
    expect(refusalAfter(120, () => checkStudentUpload("203.0.113.7", "ABCDEF"))).toMatchObject({ code: "rate_limited" });
  });

  it("put uploads without an IP in one shared bucket", () => {
    expect(refusalAfter(120, () => checkStudentUpload(null, "K7M4QX"))).toMatchObject({ code: "rate_limited" });
  });
});

describe("checkLogin", () => {
  /** A failed login: counted, and never given back. */
  const fail = (ip: string | null, email: string) => void checkLogin(ip, email);

  it("allows 10 failures per email and address per 15 minutes, in any spelling of the email", () => {
    let n = 0;
    const spellings = ["maria@example.com", " Maria@Example.com "];
    const error = refusalAfter(10, () => fail("6.6.6.6", spellings[n++ % 2]));
    expect(error).toMatchObject({ code: "rate_limited", extra: { retryAfterMs: 15 * MINUTE } });
    expect(() => checkLogin("6.6.6.6", "other@example.com")).not.toThrow();
  });

  it("does not let failures from one address lock the teacher out from another", () => {
    for (let i = 0; i < 10; i++) fail("6.6.6.6", "teacher@school.org");
    expect(() => checkLogin("6.6.6.6", "teacher@school.org")).toThrow(AppError);
    expect(() => checkLogin("1.2.3.4", "Teacher@School.org")).not.toThrow();
  });

  it("caps failures per email at 100 per 15 minutes, however many addresses they come from", () => {
    let n = 0;
    expect(passesBeforeRefusal(() => fail(`ip-${n++ % 50}`, "teacher@school.org"))).toBe(100);
    expect(() => checkLogin("1.2.3.4", "teacher@school.org")).toThrow(AppError);
    expect(() => checkLogin("1.2.3.4", "other@school.org")).not.toThrow();
  });

  it("allows 30 failures per address per 15 minutes", () => {
    let n = 0;
    expect(refusalAfter(30, () => fail("203.0.113.7", `user${n++}@example.com`))).toMatchObject({ code: "rate_limited" });
  });

  it("gives refunded attempts back, so successful logins use up nothing", () => {
    for (let i = 0; i < 200; i++) checkLogin("203.0.113.7", "maria@example.com").refund();
    for (let i = 0; i < 9; i++) fail("203.0.113.7", "maria@example.com");
    expect(() => checkLogin("203.0.113.7", "maria@example.com")).not.toThrow();
    expect(() => checkLogin("203.0.113.7", "maria@example.com")).toThrow(AppError);
  });

  it("refunds an attempt only once, and not into a later window", () => {
    const attempt = checkLogin("203.0.113.7", "maria@example.com");
    for (let i = 0; i < 5; i++) fail("203.0.113.7", "maria@example.com");
    attempt.refund();
    attempt.refund();
    expect(refusalAfter(5, () => fail("203.0.113.7", "maria@example.com"))).toMatchObject({ code: "rate_limited" });

    const late = checkLogin("198.51.100.1", "late@example.com");
    clock += 15 * MINUTE;
    for (let i = 0; i < 10; i++) fail("198.51.100.1", "late@example.com");
    late.refund(); // its window has ended; the new window keeps all 10
    expect(() => checkLogin("198.51.100.1", "late@example.com")).toThrow(AppError);
  });
});

describe("checkSignup", () => {
  it("allows 5 signups per address per hour", () => {
    expect(refusalAfter(5, () => checkSignup("203.0.113.7").refund())).toMatchObject({ extra: { retryAfterMs: 60 * MINUTE } });
    expect(() => checkSignup("203.0.113.8")).not.toThrow();
  });

  it("allows 20 wrong signup codes per hour in all, whatever the addresses", () => {
    let n = 0;
    const error = refusalAfter(20, () => void checkSignup(`ip-${n++}`));
    expect(error).toMatchObject({ code: "rate_limited", extra: { retryAfterMs: 60 * MINUTE } });
    expect(error?.message).toContain("Too many sign-up attempts.");
  });

  it("does not count refunded attempts (anything but a wrong code) against the code budget", () => {
    for (let i = 0; i < 100; i++) checkSignup(`ip-${i}`).refund();
    expect(() => checkSignup("203.0.113.7")).not.toThrow();
  });
});
