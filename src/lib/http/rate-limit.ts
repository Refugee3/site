import { now } from "@/lib/clock";
import { AppError } from "@/lib/errors";

// In-memory fixed windows. That is enough because exactly one server process runs (§7); the state lives
// on globalThis so every module copy in the process shares it, and deleting the slot resets it (§4).

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

function count(s: RateState, bucket: string, windowMs: number, nowMs: number): void {
  const window = s.windows.get(bucket);
  if (window && window.resetAt > nowMs) {
    window.count++;
    return;
  }
  s.windows.delete(bucket); // re-inserted below, which moves it to the end of the age order
  if (s.windows.size >= MAX_KEYS) s.windows.delete(s.windows.keys().next().value!);
  s.windows.set(bucket, { count: 1, resetAt: nowMs + windowMs });
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
// Rules (§8). A missing IP shares the "unknown" bucket.

interface Rule {
  bucket: string;
  limit: number;
  windowMs: number;
}

/**
 * A request counts against every rule or against none: one client over its own limit does not use up
 * the shared budgets, and refused requests never create buckets.
 */
function enforce(rules: Rule[], message: string): void {
  const nowMs = now();
  const s = state(nowMs);
  const retryAfterMs = Math.max(...rules.map((rule) => waitMs(s, rule.bucket, rule.limit, nowMs)));
  if (retryAfterMs > 0) {
    const minutes = Math.ceil(retryAfterMs / MINUTE);
    throw new AppError("rate_limited", `${message} Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, { retryAfterMs });
  }
  for (const rule of rules) count(s, rule.bucket, rule.windowMs, nowMs);
}

function ipKey(ip: string | null): string {
  return ip ?? "unknown";
}

/** Per IP (a whole class may share one NAT address), per assignment, and across all anonymous uploads. */
export function checkStudentUpload(ip: string | null, shareCode: string): void {
  enforce(
    [
      { bucket: `upload:ip:${ipKey(ip)}`, limit: 60, windowMs: 10 * MINUTE },
      { bucket: `upload:code:${shareCode}`, limit: 300, windowMs: HOUR },
      { bucket: "upload:all", limit: 1000, windowMs: HOUR },
    ],
    "Too many uploads right now.",
  );
}

export function checkLogin(ip: string | null, email: string): void {
  enforce(
    [
      { bucket: `login:ip:${ipKey(ip)}`, limit: 30, windowMs: 15 * MINUTE },
      { bucket: `login:email:${email.trim().toLowerCase()}`, limit: 10, windowMs: 15 * MINUTE },
    ],
    "Too many login attempts.",
  );
}

export function checkSignup(ip: string | null): void {
  enforce([{ bucket: `signup:ip:${ipKey(ip)}`, limit: 5, windowMs: HOUR }], "Too many sign-up attempts.");
}

/** Share-code lookups through /go; limits guessing codes. */
export function checkCodeLookup(ip: string | null): void {
  enforce([{ bucket: `go:ip:${ipKey(ip)}`, limit: 60, windowMs: MINUTE }], "Too many code lookups.");
}
