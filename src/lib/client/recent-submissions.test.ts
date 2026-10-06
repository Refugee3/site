import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRecentSubmission,
  readRecentSubmissionRaw,
  receiptPathFrom,
  recentSubmissionKey,
  rememberSubmission,
} from "./recent-submissions";

const TOKEN = "a".repeat(43);
const RECEIPT = `/r/${TOKEN}`;

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
    rememberSubmission({ code: "K7M4QX", receiptUrl: RECEIPT, at: 1_700_000_000_000 });
    const raw = readRecentSubmissionRaw("K7M4QX");
    expect(parseRecentSubmission(raw, "K7M4QX")).toEqual({
      code: "K7M4QX",
      receiptUrl: RECEIPT,
      at: 1_700_000_000_000,
    });
    expect(readRecentSubmissionRaw("ABCDEF")).toBeNull();
  });

  it("ignores malformed or tampered entries", () => {
    const parse = (value: unknown) => parseRecentSubmission(JSON.stringify(value), "K7M4QX");
    expect(parseRecentSubmission(null, "K7M4QX")).toBeNull();
    expect(parseRecentSubmission("{not json", "K7M4QX")).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse({ code: "ABCDEF", receiptUrl: RECEIPT, at: 1 })).toBeNull();
    expect(parse({ code: "K7M4QX", receiptUrl: "https://evil.example", at: 1 })).toBeNull();
    expect(parse({ code: "K7M4QX", receiptUrl: RECEIPT, at: "yesterday" })).toBeNull();
  });

  it("survives storage that throws (private browsing, quota)", () => {
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error("SecurityError");
    };
    broken.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    vi.stubGlobal("localStorage", broken);
    expect(() => rememberSubmission({ code: "K7M4QX", receiptUrl: RECEIPT, at: 1 })).not.toThrow();
    expect(readRecentSubmissionRaw("K7M4QX")).toBeNull();
  });

  it("keys entries by share code", () => {
    expect(recentSubmissionKey("K7M4QX")).toBe("pag.submission.K7M4QX");
  });
});
