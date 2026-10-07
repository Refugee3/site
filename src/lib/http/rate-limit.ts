import { now } from "@/lib/clock";
import { AppError } from "@/lib/errors";

// In-memory fixed windows. That is enough because exactly one server process runs; the state lives
// on globalThis so every module copy in the process shares it, and deleting the slot resets it.

interface RateWindow {
  count: number;
  resetAt: number;
}

interface RateState {
  /** Insertion order is window start order, so the first key is the oldest window. */
  windows: Map<string, RateWindow>;
  prunedAt: number;
}

const SLOT = Symbol.for("pag.rate");
const slots = globalThis as unknown as Record<symbol, RateState | undefined>;

const PRUNE_EVERY_MS = 60_000;
const MAX_KEYS = 50_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The process-wide state, with windows that ended dropped at most once a minute. */
function state(nowMs: number): RateState {
  let s = slots[SLOT];
  if (!s) {
    s = { windows: new Map(), prunedAt: nowMs };
    slots[SLOT] = s;
  }
  if (nowMs - s.prunedAt >= PRUNE_EVERY_MS) {
    for (const [bucket, window] of s.windows) {
      if (window.resetAt <= nowMs) s.windows.delete(bucket);
    }
    s.prunedAt = nowMs;
  }
  return s;
}

/** Milliseconds until `bucket` accepts another request; 0 when it accepts one now. */
function waitMs(s: RateState, bucket: string, limit: number, nowMs: number): number {
  const window = s.windows.get(bucket);
  return window && window.resetAt > nowMs && window.count >= limit ? window.resetAt - nowMs : 0;
}

/** Counts one request against `bucket` and returns the window it was counted in. */
function count(s: RateState, bucket: string, windowMs: number, nowMs: number): RateWindow {
  const window = s.windows.get(bucket);
  if (window && window.resetAt > nowMs) {
    window.count++;
    return window;
  }
  s.windows.delete(bucket); // re-inserted below, which moves it to the end of the age order
  if (s.windows.size >= MAX_KEYS) s.windows.delete(s.windows.keys().next().value!);
  const fresh = { count: 1, resetAt: nowMs + windowMs };
  s.windows.set(bucket, fresh);
  return fresh;
}

/** Counts one request against `bucket`, allowing `limit` per window of `windowMs`; refused requests are not counted. */
export function hit(bucket: string, limit: number, windowMs: number, nowMs: number = now()): { ok: true } | { ok: false; retryAfterMs: number } {
  const s = state(nowMs);
  const retryAfterMs = waitMs(s, bucket, limit, nowMs);
  if (retryAfterMs > 0) return { ok: false, retryAfterMs };
  count(s, bucket, windowMs, nowMs);
  return { ok: true };
}

export function resetRateLimitsForTests(): void {
  delete slots[SLOT];
}

// ---------------------------------------------------------------------------------------------
// Rules. A missing IP shares the "unknown" bucket.
//
// Each check refuses before any work when one of its rules is full, but charges only the rules that the
// request should use up: per-IP rules for whatever an address sends, shared (IP-independent) rules only for
// requests that cost something. Junk therefore never uses up a budget that other people depend on, and a
// school behind one NAT address is not limited like a single client.

interface Rule {
  bucket: string;
  limit: number;
  windowMs: number;
}

/** A counted request that can be taken back, e.g. once a login turns out to be correct. */
export interface Charge {
  refund(): void;
}

/** Throws AppError("rate_limited") when any of `rules` is full; counts nothing. */
function peek(rules: Rule[], message: string): void {
  const nowMs = now();
  const s = state(nowMs);
  const retryAfterMs = Math.max(0, ...rules.map((rule) => waitMs(s, rule.bucket, rule.limit, nowMs)));
  if (retryAfterMs > 0) {
    const minutes = Math.ceil(retryAfterMs / MINUTE);
    throw new AppError("rate_limited", `${message} Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, { retryAfterMs });
  }
}

/**
 * Counts one request against every rule. Counting happens before the work it guards (a burst of
 * concurrent requests cannot all slip past a limit), and `refund` gives the request back afterwards,
 * unless its window has ended in the meantime.
 */
function charge(rules: Rule[]): Charge {
  const nowMs = now();
  const s = state(nowMs);
  const windows = rules.map((rule) => count(s, rule.bucket, rule.windowMs, nowMs));
  let refunded = false;
  return {
    refund() {
      if (refunded) return;
      refunded = true;
      for (const window of windows) window.count = Math.max(0, window.count - 1);
    },
  };
}

/** `peek` at every rule, then `charge` the given ones: a refused request counts against no rule at all. */
function enforce(rules: Rule[], message: string, charged: Rule[] = rules): Charge {
  peek(rules, message);
  return charge(charged);
}

function ipKey(ip: string | null): string {
  return ip ?? "unknown";
}

function codeLookupMisses(ip: string | null): Rule {
  return { bucket: `lookup:miss:ip:${ipKey(ip)}`, limit: 60, windowMs: MINUTE };
}

/**
 * Before looking up a share code (/go, the /s/[code] page and student uploads): refuses an IP that has
 * asked for 60 unknown codes within the minute. Only misses are counted (`countCodeLookupMiss`), so a
 * whole school behind one address can open real codes freely. Once the limit is reached, known codes are
 * refused too, or the refusal itself would tell guessed codes apart.
 */
export function checkCodeLookup(ip: string | null): void {
  peek([codeLookupMisses(ip)], "Too many code lookups.");
}

/** A share code that matched no assignment. */
export function countCodeLookupMiss(ip: string | null): void {
  charge([codeLookupMisses(ip)]);
}

function newSubmissionRules(shareCode: string): Rule[] {
  return [
    { bucket: `upload:code:${shareCode}`, limit: 300, windowMs: HOUR },
    { bucket: "upload:all", limit: 1000, windowMs: HOUR },
  ];
}

/**
 * Before reading the body of an upload to an open assignment. Counts the request per IP and assignment
 * (one class behind one NAT address, retries included) and per IP (several classes behind it), and
 * refuses when the assignment's or the server's budget of new submissions is used up. Those two budgets
 * bound what uploads cost whatever the IPs, so only uploads that create a submission count against them
 * (`countStudentSubmission`).
 */
export function checkStudentUpload(ip: string | null, shareCode: string): void {
  const perIp: Rule[] = [
    { bucket: `upload:ipcode:${ipKey(ip)}:${shareCode}`, limit: 120, windowMs: 10 * MINUTE },
    { bucket: `upload:ip:${ipKey(ip)}`, limit: 300, windowMs: 10 * MINUTE },
  ];
  enforce([...perIp, ...newSubmissionRules(shareCode)], "Too many uploads right now.", perIp);
}

/** A student upload that created a submission (not a replay of an earlier one). */
export function countStudentSubmission(shareCode: string): void {
  charge(newSubmissionRules(shareCode));
}

/**
 * Before checking a password. The strict limit is per email and IP, so failures from elsewhere cannot lock
 * a teacher out; the much higher per-email ceiling bounds guessing spread over many addresses. The
 * attempt counts while it runs; the caller refunds it when the credentials are right, so only failures
 * use up the limits.
 */
export function checkLogin(ip: string | null, email: string): Charge {
  const normalized = email.trim().toLowerCase();
  return enforce(
    [
      { bucket: `login:emailip:${normalized}:${ipKey(ip)}`, limit: 10, windowMs: 15 * MINUTE },
      { bucket: `login:email:${normalized}`, limit: 100, windowMs: 15 * MINUTE },
      { bucket: `login:ip:${ipKey(ip)}`, limit: 30, windowMs: 15 * MINUTE },
    ],
    "Too many login attempts.",
  );
}

/**
 * Before a signup: 5 attempts per IP per hour, and at most 20 wrong signup codes per hour server-wide,
 * because IPs can be rotated or spoofed and the code is all that stands between a stranger and an account.
 * Returns the wrong-code charge, which the caller refunds unless the attempt failed on a wrong code.
 */
export function checkSignup(ip: string | null): Charge {
  const perIp: Rule = { bucket: `signup:ip:${ipKey(ip)}`, limit: 5, windowMs: HOUR };
  const wrongCodes: Rule = { bucket: "signup:badcode:all", limit: 20, windowMs: HOUR };
  enforce([perIp, wrongCodes], "Too many sign-up attempts.", [perIp]);
  return charge([wrongCodes]);
}
