/**
 * What the student upload form remembers (in localStorage) so a student who reopens /s/CODE soon after
 * uploading is told a paper went in from this device. Devices are often shared (class iPads, Chromebooks,
 * family phones), so an entry expires after RECENT_SUBMISSION_TTL_MS and can be forgotten from the page.
 */
export interface RecentSubmission {
  code: string;
  receiptUrl: string;
  at: number;
}

/** How long an upload is remembered: long enough to come back to the code page within a class period or so. */
export const RECENT_SUBMISSION_TTL_MS = 3 * 60 * 60 * 1000;
// A device clock that steps back a little (time sync) must not hide an upload made just now.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const KEY_PREFIX = "pag.submission.";
// Only our own receipt paths are ever stored or followed, so a tampered entry cannot become an open redirect.
const RECEIPT_PATH_RE = /^\/r\/[A-Za-z0-9_-]{43}$/;

// Same-tab changes (forgetSubmission, rememberSubmission) fire no "storage" event, so subscribers are told directly.
const localListeners = new Set<() => void>();

function notifyLocalListeners(): void {
  for (const listener of localListeners) listener();
}

export function recentSubmissionKey(code: string): string {
  return KEY_PREFIX + code;
}

/** The receipt path from a successful student upload response body, or null if it carries no valid one. */
export function receiptPathFrom(json: unknown): string | null {
  const url = (json as { receiptUrl?: unknown } | null)?.receiptUrl;
  return typeof url === "string" && RECEIPT_PATH_RE.test(url) ? url : null;
}

export function rememberSubmission(entry: RecentSubmission): void {
  try {
    pruneRecentSubmissions(entry.at);
    localStorage.setItem(recentSubmissionKey(entry.code), JSON.stringify(entry));
  } catch {
    // Storage disabled or full (private browsing): the receipt page itself still works.
  }
  notifyLocalListeners();
}

/** Forgets the upload remembered for `code` on this device ("Not me — forget it"). */
export function forgetSubmission(code: string): void {
  try {
    localStorage.removeItem(recentSubmissionKey(code));
  } catch {
    // Storage disabled: nothing was remembered.
  }
  notifyLocalListeners();
}

/** Removes remembered uploads that are expired or unreadable. */
export function pruneRecentSubmissions(now: number): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      if (!parseRecentSubmission(localStorage.getItem(key), key.slice(KEY_PREFIX.length), now)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Storage disabled: nothing to prune.
  }
}

/** The raw stored string, or null when storage is unavailable. */
export function readRecentSubmissionRaw(code: string): string | null {
  try {
    return localStorage.getItem(recentSubmissionKey(code));
  } catch {
    return null;
  }
}

/**
 * The stored entry for `code`, or null when it is missing, malformed, tampered with, or not from the
 * last RECENT_SUBMISSION_TTL_MS before `now` (an `at` in the future counts as unreadable).
 */
export function parseRecentSubmission(raw: string | null, code: string, now: number): RecentSubmission | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = value as Partial<RecentSubmission> | null;
  if (entry?.code !== code) return null;
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return null;
  const age = now - entry.at;
  if (!(age >= -CLOCK_SKEW_MS && age <= RECENT_SUBMISSION_TTL_MS)) return null;
  if (typeof entry.receiptUrl !== "string" || !RECEIPT_PATH_RE.test(entry.receiptUrl)) return null;
  return { code, receiptUrl: entry.receiptUrl, at: entry.at };
}

const snapshots = new Map<string, { raw: string; entry: RecentSubmission }>();

/**
 * The upload remembered for `code` if it is still fresh at `now`, else null. While the stored value is
 * unchanged the same object is returned, so this can be a useSyncExternalStore snapshot.
 */
export function readRecentSubmission(code: string, now: number): RecentSubmission | null {
  const raw = readRecentSubmissionRaw(code);
  const entry = parseRecentSubmission(raw, code, now);
  if (raw === null || entry === null) return null;
  const cached = snapshots.get(code);
  if (cached?.raw === raw) return cached.entry;
  snapshots.set(code, { raw, entry });
  return entry;
}

/**
 * The share code this browser uploaded the receipt `receiptPath` with, or null when it did not, the
 * upload is no longer remembered, or storage is unavailable. Only the newest upload per code is
 * remembered, so older receipts find none.
 */
export function codeForReceipt(receiptPath: string, now: number): string | null {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const entry = parseRecentSubmission(localStorage.getItem(key), key.slice(KEY_PREFIX.length), now);
      if (entry?.receiptUrl === receiptPath) return entry.code;
    }
  } catch {
    // Storage disabled (private browsing): no link back to the upload page.
  }
  return null;
}

/** Subscribes to changes made in other tabs and, through this module, in this one. */
export function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  localListeners.add(onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    localListeners.delete(onChange);
  };
}
