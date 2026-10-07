import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  codeForReceipt,
  forgetSubmission,
  parseRecentSubmission,
  pruneRecentSubmissions,
  readRecentSubmission,
  readRecentSubmissionRaw,
  receiptPathFrom,
  RECENT_SUBMISSION_TTL_MS,
  recentSubmissionKey,
  rememberSubmission,
  subscribeToStorage,
} from "./recent-submissions";

const TOKEN = "a".repeat(43);
const RECEIPT = `/r/${TOKEN}`;
const AT = 1_700_000_000_000;
const MINUTE = 60_000;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", new EventTarget());
});

describe("receiptPathFrom", () => {
  it("accepts only our own receipt paths", () => {
    expect(receiptPathFrom({ receiptUrl: RECEIPT, duplicate: true })).toBe(RECEIPT);
    expect(receiptPathFrom({ receiptUrl: `https://evil.example/r/${TOKEN}` })).toBeNull();
    expect(receiptPathFrom({ receiptUrl: "javascript:alert(1)" })).toBeNull();
    expect(receiptPathFrom({ receiptUrl: "/r/short" })).toBeNull();
    expect(receiptPathFrom({})).toBeNull();
    expect(receiptPathFrom(null)).toBeNull();
  });
});

describe("remembered submissions", () => {
  it("round-trips through localStorage per share code", () => {
    rememberSubmission({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT });
    const raw = readRecentSubmissionRaw("K7M4QX");
    expect(parseRecentSubmission(raw, "K7M4QX", AT + MINUTE)).toEqual({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT });
    expect(readRecentSubmissionRaw("ABCDEF")).toBeNull();
  });

  it("ignores malformed or tampered entries", () => {
    const parse = (value: unknown) => parseRecentSubmission(JSON.stringify(value), "K7M4QX", AT);
    expect(parseRecentSubmission(null, "K7M4QX", AT)).toBeNull();
    expect(parseRecentSubmission("{not json", "K7M4QX", AT)).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse({ code: "ABCDEF", receiptUrl: RECEIPT, at: AT })).toBeNull();
    expect(parse({ code: "K7M4QX", receiptUrl: "https://evil.example", at: AT })).toBeNull();
    expect(parse({ code: "K7M4QX", receiptUrl: RECEIPT, at: "yesterday" })).toBeNull();
    expect(parse({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT })).not.toBeNull();
  });

  it("expires entries, so the next person on a shared device is not shown an old upload", () => {
    const raw = JSON.stringify({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT });
    const at = (now: number) => parseRecentSubmission(raw, "K7M4QX", now)?.at ?? null;
    expect(at(AT)).toBe(AT);
    expect(at(AT + RECENT_SUBMISSION_TTL_MS)).toBe(AT);
    expect(at(AT + RECENT_SUBMISSION_TTL_MS + 1)).toBeNull();
    expect(at(AT + 24 * 60 * MINUTE)).toBeNull();
    // A clock stepped back a little still shows a fresh upload; an entry from the future does not count.
    expect(at(AT - MINUTE)).toBe(AT);
    expect(at(AT - 60 * MINUTE)).toBeNull();
    expect(at(Number.NaN)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(parseRecentSubmission(JSON.stringify({ code: "K7M4QX", receiptUrl: RECEIPT, at: bad }), "K7M4QX", AT)).toBeNull();
    }
  });

  it("reads the fresh entry as a stable snapshot", () => {
    rememberSubmission({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT });
    const first = readRecentSubmission("K7M4QX", AT + MINUTE);
    expect(first).toEqual({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT });
    expect(readRecentSubmission("K7M4QX", AT + 2 * MINUTE)).toBe(first);
    expect(readRecentSubmission("K7M4QX", AT + RECENT_SUBMISSION_TTL_MS + 1)).toBeNull();
    rememberSubmission({ code: "K7M4QX", receiptUrl: `/r/${"b".repeat(43)}`, at: AT + MINUTE });
    expect(readRecentSubmission("K7M4QX", AT + 2 * MINUTE)?.receiptUrl).toBe(`/r/${"b".repeat(43)}`);
  });

  it("forgets an entry on request and tells same-tab subscribers", () => {
    rememberSubmission({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT });
    rememberSubmission({ code: "ABC234", receiptUrl: RECEIPT, at: AT });
    const onChange = vi.fn();
    const unsubscribe = subscribeToStorage(onChange);
    forgetSubmission("K7M4QX");
    expect(localStorage.getItem(recentSubmissionKey("K7M4QX"))).toBeNull();
    expect(readRecentSubmission("K7M4QX", AT)).toBeNull();
    expect(readRecentSubmission("ABC234", AT)).not.toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    forgetSubmission("ABC234");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("removes expired and unreadable entries, leaving fresh and unrelated ones", () => {
    rememberSubmission({ code: "OLD111", receiptUrl: RECEIPT, at: AT });
    rememberSubmission({ code: "NEW222", receiptUrl: RECEIPT, at: AT + RECENT_SUBMISSION_TTL_MS });
    localStorage.setItem(recentSubmissionKey("BAD333"), "{not json");
    localStorage.setItem("unrelated", "x");
    pruneRecentSubmissions(AT + RECENT_SUBMISSION_TTL_MS + 1);
    expect(localStorage.getItem(recentSubmissionKey("OLD111"))).toBeNull();
    expect(localStorage.getItem(recentSubmissionKey("BAD333"))).toBeNull();
    expect(localStorage.getItem(recentSubmissionKey("NEW222"))).not.toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("x");
  });

  it("prunes expired entries when a new upload is remembered", () => {
    rememberSubmission({ code: "OLD111", receiptUrl: RECEIPT, at: AT });
    rememberSubmission({ code: "NEW222", receiptUrl: RECEIPT, at: AT + RECENT_SUBMISSION_TTL_MS + 1 });
    expect(localStorage.getItem(recentSubmissionKey("OLD111"))).toBeNull();
    expect(localStorage.getItem(recentSubmissionKey("NEW222"))).not.toBeNull();
  });

  it("survives storage that throws (private browsing, quota)", () => {
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error("SecurityError");
    };
    broken.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    broken.removeItem = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", broken);
    expect(() => rememberSubmission({ code: "K7M4QX", receiptUrl: RECEIPT, at: AT })).not.toThrow();
    expect(() => forgetSubmission("K7M4QX")).not.toThrow();
    expect(() => pruneRecentSubmissions(AT)).not.toThrow();
    expect(readRecentSubmissionRaw("K7M4QX")).toBeNull();
    expect(readRecentSubmission("K7M4QX", AT)).toBeNull();
  });

  it("keys entries by share code", () => {
    expect(recentSubmissionKey("K7M4QX")).toBe("pag.submission.K7M4QX");
  });
});

describe("codeForReceipt", () => {
  it("finds the code this browser uploaded the receipt with", () => {
    rememberSubmission({ code: "ABC234", receiptUrl: RECEIPT, at: AT });
    rememberSubmission({ code: "XYZ789", receiptUrl: `/r/${"b".repeat(43)}`, at: AT + 1 });
    localStorage.setItem("unrelated", "x");
    expect(codeForReceipt(RECEIPT, AT + MINUTE)).toBe("ABC234");
    expect(codeForReceipt(`/r/${"c".repeat(43)}`, AT + MINUTE)).toBeNull();
    expect(codeForReceipt(RECEIPT, AT + RECENT_SUBMISSION_TTL_MS + 1)).toBeNull();
  });

  it("ignores tampered entries and unavailable storage", () => {
    localStorage.setItem(recentSubmissionKey("ABC234"), JSON.stringify({ code: "OTHER1", receiptUrl: RECEIPT, at: AT }));
    expect(codeForReceipt(RECEIPT, AT)).toBeNull();
    vi.stubGlobal("localStorage", undefined);
    expect(codeForReceipt(RECEIPT, AT)).toBeNull();
  });
});
