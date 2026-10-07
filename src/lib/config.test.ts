import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigForTests } from "@/lib/config";

const CONFIG_VARS = [
  "NODE_ENV", "DATA_DIR", "APP_URL", "AI_MODE", "ALLOW_FAKE_AI", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_EFFORT",
  "AI_FALLBACKS", "AI_CACHE_TTL", "AI_TIMEOUT_MS", "GRADING_CONCURRENCY", "JOB_MAX_ATTEMPTS", "TEACHER_SIGNUP_CODE",
  "COOKIE_SECURE", "MAX_UPLOAD_MB", "MAX_PAGES",
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
      model: "claude-opus-5-5",
      effort: "high",
      fallbacks: true,
      cacheTtl: "1h",
      aiTimeoutMs: 600_000,
      jobTimeoutMs: 2_700_000,
      maxTokens: 64_000,
      maxTokensCeiling: 128_000,
      concurrency: 3,
      jobMaxAttempts: 4,
      teacherSignupCode: null,
      cookieSecure: false,
      maxUploadBytes: 20 * 1_048_576,
      maxPages: 40,
      maxUploadFiles: 20,
      maxKeyItems: 200,
    });
  });

  it("parses every configurable variable", () => {
    const cfg = configWith({
      NODE_ENV: "production",
      DATA_DIR: "/srv/grader",
      APP_URL: "https://grader.school.org/",
      AI_MODE: "claude",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_MODEL: "claude-other",
      ANTHROPIC_EFFORT: "medium",
      AI_FALLBACKS: "off",
      AI_CACHE_TTL: "5m",
      AI_TIMEOUT_MS: "30000",
      GRADING_CONCURRENCY: "8",
      JOB_MAX_ATTEMPTS: "1",
      TEACHER_SIGNUP_CODE: " maple-quartz-4417 ",
      MAX_UPLOAD_MB: "5",
      MAX_PAGES: "200",
    });
    expect(cfg).toMatchObject({
      nodeEnv: "production",
      dataDir: "/srv/grader",
      appUrl: "https://grader.school.org",
      hasApiKey: true,
      model: "claude-other",
      effort: "medium",
      fallbacks: false,
      cacheTtl: "5m",
      aiTimeoutMs: 30_000,
      concurrency: 8,
      jobMaxAttempts: 1,
      teacherSignupCode: "maple-quartz-4417",
      cookieSecure: true,
      maxUploadBytes: 5 * 1_048_576,
      maxPages: 200,
    });
  });

  it("treats empty and blank values as unset", () => {
    const cfg = configWith({ ANTHROPIC_API_KEY: "  ", GRADING_CONCURRENCY: "", TEACHER_SIGNUP_CODE: "" });
    expect(cfg.hasApiKey).toBe(false);
    expect(cfg.concurrency).toBe(3);
    expect(cfg.teacherSignupCode).toBeNull();
  });

  it("requires a TEACHER_SIGNUP_CODE of at least 12 characters (after trimming), since it gates every signup", () => {
    expect(() => configWith({ TEACHER_SIGNUP_CODE: "letmein" })).toThrow(/TEACHER_SIGNUP_CODE: must be at least 12 characters/);
    expect(() => configWith({ TEACHER_SIGNUP_CODE: "  math2026xx  " })).toThrow(/TEACHER_SIGNUP_CODE/);
    expect(configWith({ TEACHER_SIGNUP_CODE: "k3v9-qp2m-x7tw" }).teacherSignupCode).toBe("k3v9-qp2m-x7tw");
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
      configWith({ GRADING_CONCURRENCY: "9", MAX_UPLOAD_MB: "abc", AI_MODE: "openai", ANTHROPIC_EFFORT: "extreme" });
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
    ["JOB_MAX_ATTEMPTS", "11"],
    ["MAX_UPLOAD_MB", "23"],
    ["MAX_PAGES", "0"],
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
