/** What the student upload form remembers (in localStorage) so a reopened /s/CODE can link to the receipt. */
export interface RecentSubmission {
  code: string;
  receiptUrl: string;
  at: number;
}

const KEY_PREFIX = "pag.submission.";
// Only our own receipt paths are ever stored or followed, so a tampered entry cannot become an open redirect.
const RECEIPT_PATH_RE = /^\/r\/[A-Za-z0-9_-]{43}$/;

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
    localStorage.setItem(recentSubmissionKey(entry.code), JSON.stringify(entry));
  } catch {
    // Storage disabled or full (private browsing): the receipt page itself still works.
  }
}

/** The raw stored string: a stable snapshot for useSyncExternalStore. */
export function readRecentSubmissionRaw(code: string): string | null {
  try {
    return localStorage.getItem(recentSubmissionKey(code));
  } catch {
    return null;
  }
}

export function parseRecentSubmission(raw: string | null, code: string): RecentSubmission | null {
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
  if (typeof entry.receiptUrl !== "string" || !RECEIPT_PATH_RE.test(entry.receiptUrl)) return null;
  return { code, receiptUrl: entry.receiptUrl, at: entry.at };
}

/** Subscribes to changes made in other tabs. */
export function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
