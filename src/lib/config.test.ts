import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MODEL_RETIRED, getConfig, resetConfigForTests } from "@/lib/config";

const CONFIG_VARS = [
  "NODE_ENV", "DATA_DIR", "APP_URL", "AI_MODE", "ALLOW_FAKE_AI", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_EFFORT",
  "AI_FALLBACKS", "AI_CACHE_TTL", "AI_TIMEOUT_MS", "GRADING_CONCURRENCY", "JOB_MAX_ATTEMPTS", "TEACHER_SIGNUP_CODE",
  "COOKIE_SECURE", "MAX_UPLOAD_MB", "MAX_PAGES", "APP_SECRET", "MAX_SCAN_MB", "MAX_SCAN_PAGES", "AGENT_BUDGET_EXTRACT_USD",
  "AGENT_BUDGET_GRADE_USD", "AGENT_BUDGET_SCAN_USD", "AGENT_SESSION_TIMEOUT_MS", "AGENT_KEEP_SESSIONS", "SCAN_SPLIT_PARALLEL",
];

/** Starts from an empty environment (setup.ts restores it after each test), then applies `vars`. */
function configWith(vars: Record<string, string> = {}) {
  for (const name of CONFIG_VARS) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  resetConfigForTests();
  return getConfig();
}

describe("getConfig", () => {
  it("applies the documented defaults", () => {
    expect(configWith()).toEqual({
      nodeEnv: "development",
      dataDir: path.resolve(process.cwd(), "./data"),
      appUrl: null,
      aiMode: "claude",
      hasApiKey: false,
      appSecret: null,
      effort: "high",
      fallbacks: true,
      cacheTtl: "1h",
      aiTimeoutMs: 600_000,
      jobTimeoutMs: 2_700_000,
      maxTokens: 64_000,
      maxTokensCeiling: 128_000,
      concurrency: 10,
      scanSplitParallel: 4,
      jobMaxAttempts: 4,
      teacherSignupCode: null,
      cookieSecure: false,
      maxUploadBytes: 20 * 1_048_576,
      maxPages: 40,
      maxScanBytes: 100 * 1_048_576,
      maxScanPages: 200,
      maxUploadFiles: 20,
      maxKeyItems: 200,
      agentBudgetCents: { extract: 300, grade: 200, scan: 150 },
      agentSessionTimeoutMs: 1_200_000,
      agentKeepSessions: false,
      startupWarnings: [],
    });
  });

  it("parses every configurable variable", () => {
    const cfg = configWith({
      NODE_ENV: "production",
      DATA_DIR: "/srv/grader",
      APP_URL: "https://grader.school.org/",
      AI_MODE: "claude",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_EFFORT: "medium",
      AI_FALLBACKS: "off",
      AI_CACHE_TTL: "5m",
      AI_TIMEOUT_MS: "30000",
      GRADING_CONCURRENCY: "32",
      SCAN_SPLIT_PARALLEL: "8",
      JOB_MAX_ATTEMPTS: "1",
      TEACHER_SIGNUP_CODE: " maple-quartz-4417 ",
      MAX_UPLOAD_MB: "5",
      MAX_PAGES: "200",
      APP_SECRET: " 0123456789abcdefghijklmnopqrstuv ",
      MAX_SCAN_MB: "200",
      MAX_SCAN_PAGES: "500",
      AGENT_BUDGET_EXTRACT_USD: "5",
      AGENT_BUDGET_GRADE_USD: " 2.5 ",
      AGENT_BUDGET_SCAN_USD: "0.75",
      AGENT_SESSION_TIMEOUT_MS: "600000",
      AGENT_KEEP_SESSIONS: "1",
    });
    expect(cfg).toMatchObject({
      nodeEnv: "production",
      dataDir: "/srv/grader",
      appUrl: "https://grader.school.org",
      hasApiKey: true,
      effort: "medium",
      fallbacks: false,
      cacheTtl: "5m",
      aiTimeoutMs: 30_000,
      concurrency: 32,
      scanSplitParallel: 8,
      jobMaxAttempts: 1,
      teacherSignupCode: "maple-quartz-4417",
      cookieSecure: true,
      maxUploadBytes: 5 * 1_048_576,
      maxPages: 200,
      appSecret: "0123456789abcdefghijklmnopqrstuv",
      maxScanBytes: 200 * 1_048_576,
      maxScanPages: 500,
      agentBudgetCents: { extract: 500, grade: 250, scan: 75 },
      agentSessionTimeoutMs: 600_000,
      agentKeepSessions: true,
    });
  });

  it("ignores a retired ANTHROPIC_MODEL, whatever its value, with one startup warning that points to Settings", () => {
    expect(ANTHROPIC_MODEL_RETIRED).toBe("ANTHROPIC_MODEL is no longer used — choose the model on the Settings page.");
    // The value .env.example used to suggest: it must not keep a server on Opus behind the Settings page's back.
    for (const value of ["claude-opus-5-5", "claude-sonnet-5-5", "not-a-model"]) {
      const cfg = configWith({ ANTHROPIC_MODEL: value });
      expect(cfg.startupWarnings, value).toEqual([ANTHROPIC_MODEL_RETIRED]);
      expect(cfg).not.toHaveProperty("model");
    }
    expect(configWith({ ANTHROPIC_MODEL: "  " }).startupWarnings).toEqual([]);
    expect(configWith().startupWarnings).toEqual([]);
  });

  it("treats empty and blank values as unset", () => {
    const cfg = configWith({ ANTHROPIC_API_KEY: "  ", GRADING_CONCURRENCY: "", TEACHER_SIGNUP_CODE: "" });
    expect(cfg.hasApiKey).toBe(false);
    expect(cfg.concurrency).toBe(10);
    expect(cfg.teacherSignupCode).toBeNull();
  });

  it("requires a TEACHER_SIGNUP_CODE of at least 12 characters (after trimming), since it gates every signup", () => {
    expect(() => configWith({ TEACHER_SIGNUP_CODE: "letmein" })).toThrow(/TEACHER_SIGNUP_CODE: must be at least 12 characters/);
    expect(() => configWith({ TEACHER_SIGNUP_CODE: "  math2026xx  " })).toThrow(/TEACHER_SIGNUP_CODE/);
    expect(configWith({ TEACHER_SIGNUP_CODE: "k3v9-qp2m-x7tw" }).teacherSignupCode).toBe("k3v9-qp2m-x7tw");
  });

  it("requires an APP_SECRET of at least 32 characters (after trimming), and treats an empty one as unset", () => {
    expect(() => configWith({ APP_SECRET: "a".repeat(31) })).toThrow(
      /APP_SECRET: must be at least 32 characters; generate one with: openssl rand -base64 32/,
    );
    expect(() => configWith({ APP_SECRET: ` ${"a".repeat(31)} ` })).toThrow(/APP_SECRET/);
    expect(configWith({ APP_SECRET: "a".repeat(32) }).appSecret).toBe("a".repeat(32));
    expect(configWith({ APP_SECRET: "  " }).appSecret).toBeNull();
  });

  it("does not echo a too-short APP_SECRET in the error", () => {
    let message = "";
    try {
      configWith({ APP_SECRET: "hunter2-secret" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("APP_SECRET");
    expect(message).not.toContain("hunter2");
  });

  it("grades up to 32 papers at once and reads up to 8 chunks of a scan at once", () => {
    expect(configWith({ GRADING_CONCURRENCY: "1", SCAN_SPLIT_PARALLEL: "1" })).toMatchObject({ concurrency: 1, scanSplitParallel: 1 });
    expect(configWith({ GRADING_CONCURRENCY: "32", SCAN_SPLIT_PARALLEL: "8" })).toMatchObject({ concurrency: 32, scanSplitParallel: 8 });
  });

  it("parses the scan limits within their ranges", () => {
    expect(configWith({ MAX_SCAN_MB: "1", MAX_SCAN_PAGES: "1" })).toMatchObject({ maxScanBytes: 1_048_576, maxScanPages: 1 });
  });

  it("reads the hosted agent's spending caps as dollars with up to two decimals, in cents", () => {
    expect(configWith({ AGENT_BUDGET_GRADE_USD: "1.5" }).agentBudgetCents.grade).toBe(150);
    expect(configWith({ AGENT_BUDGET_GRADE_USD: "1.15" }).agentBudgetCents.grade).toBe(115);
    expect(configWith({ AGENT_BUDGET_EXTRACT_USD: "0.10", AGENT_BUDGET_SCAN_USD: "50" }).agentBudgetCents)
      .toEqual({ extract: 10, grade: 200, scan: 5000 });
    expect(configWith({ AGENT_BUDGET_SCAN_USD: "  " }).agentBudgetCents.scan).toBe(150);
  });

  it.each(["0.05", "0.09", "51", "50.01", "abc", "1.555", "-1", ".5", "1e1", "$2"])("rejects a spending cap of %j", (value) => {
    for (const name of ["AGENT_BUDGET_EXTRACT_USD", "AGENT_BUDGET_GRADE_USD", "AGENT_BUDGET_SCAN_USD"]) {
      expect(() => configWith({ [name]: value }), name).toThrow(
        `${name}: must be a dollar amount between 0.10 and 50, such as 2 or 1.50`,
      );
    }
  });

  it("bounds the hosted agent's session timeout and keeps sessions only for AGENT_KEEP_SESSIONS=1", () => {
    expect(configWith({ AGENT_SESSION_TIMEOUT_MS: "60000" }).agentSessionTimeoutMs).toBe(60_000);
    expect(configWith({ AGENT_SESSION_TIMEOUT_MS: "2700000" }).agentSessionTimeoutMs).toBe(2_700_000);
    for (const value of ["59999", "2700001", "90000.5"]) {
      expect(() => configWith({ AGENT_SESSION_TIMEOUT_MS: value }), value).toThrow(/AGENT_SESSION_TIMEOUT_MS/);
    }
    expect(configWith({ AGENT_KEEP_SESSIONS: "1" }).agentKeepSessions).toBe(true);
    expect(configWith({ AGENT_KEEP_SESSIONS: "0" }).agentKeepSessions).toBe(false);
    for (const value of ["true", "yes", "2"]) {
      expect(() => configWith({ AGENT_KEEP_SESSIONS: value }), value).toThrow(/AGENT_KEEP_SESSIONS/);
    }
  });

  it("derives cookieSecure from APP_URL unless set explicitly", () => {
    expect(configWith({ APP_URL: "http://localhost:3000" }).cookieSecure).toBe(false);
    expect(configWith({ APP_URL: "https://grader.school.org" }).cookieSecure).toBe(true);
    expect(configWith({ APP_URL: "https://grader.school.org", COOKIE_SECURE: "false" }).cookieSecure).toBe(false);
    expect(configWith({ COOKIE_SECURE: "true" }).cookieSecure).toBe(true);
  });

  it("accepts only on or off for AI_FALLBACKS, on by default", () => {
    expect(configWith({ AI_FALLBACKS: "on" }).fallbacks).toBe(true);
    expect(configWith({ AI_FALLBACKS: "off" }).fallbacks).toBe(false);
    expect(configWith({}).fallbacks).toBe(true);
    // A typo must not silently leave fallbacks on against the admin's choice.
    for (const value of ["yes", "false", "0", "OFF"]) {
      expect(() => configWith({ AI_FALLBACKS: value }), value).toThrow(/AI_FALLBACKS/);
    }
  });

  it("refuses fake AI in production unless ALLOW_FAKE_AI=1", () => {
    expect(() => configWith({ NODE_ENV: "production", AI_MODE: "fake" })).toThrow(/ALLOW_FAKE_AI=1/);
    expect(() => configWith({ NODE_ENV: "production", AI_MODE: "fake", ALLOW_FAKE_AI: "0" })).toThrow(/ALLOW_FAKE_AI=1/);
    expect(configWith({ NODE_ENV: "production", AI_MODE: "fake", ALLOW_FAKE_AI: "1" }).aiMode).toBe("fake");
    expect(configWith({ NODE_ENV: "development", AI_MODE: "fake" }).aiMode).toBe("fake");
  });

  it("lists every invalid variable in one error", () => {
    let message = "";
    try {
      configWith({ GRADING_CONCURRENCY: "33", MAX_UPLOAD_MB: "abc", AI_MODE: "openai", ANTHROPIC_EFFORT: "extreme" });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ["GRADING_CONCURRENCY", "MAX_UPLOAD_MB", "AI_MODE", "ANTHROPIC_EFFORT"]) {
      expect(message).toContain(name);
    }
  });

  it.each([
    ["AI_TIMEOUT_MS", "9999"],
    ["GRADING_CONCURRENCY", "0"],
    ["GRADING_CONCURRENCY", "2.5"],
    ["GRADING_CONCURRENCY", "33"],
    ["SCAN_SPLIT_PARALLEL", "0"],
    ["SCAN_SPLIT_PARALLEL", "9"],
    ["SCAN_SPLIT_PARALLEL", "1.5"],
    ["JOB_MAX_ATTEMPTS", "11"],
    ["MAX_UPLOAD_MB", "23"],
    ["MAX_PAGES", "0"],
    ["MAX_SCAN_MB", "0"],
    ["MAX_SCAN_MB", "201"],
    ["MAX_SCAN_PAGES", "0"],
    ["MAX_SCAN_PAGES", "501"],
    ["MAX_SCAN_PAGES", "1.5"],
    ["AI_CACHE_TTL", "10m"],
    ["COOKIE_SECURE", "yes"],
    ["APP_URL", "grader.school.org"],
    ["APP_URL", "ftp://grader.school.org"],
    ["APP_URL", "https://grader.school.org/app"],
  ])("rejects %s=%j", (name, value) => {
    expect(() => configWith({ [name]: value })).toThrow(name);
  });

  it("is memoized until reset", () => {
    const first = configWith({ MAX_PAGES: "12" });
    vi.stubEnv("MAX_PAGES", "13");
    expect(getConfig()).toBe(first);
    resetConfigForTests();
    expect(getConfig().maxPages).toBe(13);
  });
});
