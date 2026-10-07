import path from "node:path";
import * as z from "zod";
import type { Effort } from "@/lib/types";

export interface AppConfig {
  nodeEnv: string;
  /** Absolute path. */
  dataDir: string;
  /** Public origin without a trailing slash, e.g. "https://grader.school.org". */
  appUrl: string | null;
  aiMode: "claude" | "fake";
  hasApiKey: boolean;
  /** Master secret for encrypting the saved API key; null → DATA_DIR/secret.key. Never log the config object. */
  appSecret: string | null;
  effort: Effort;
  fallbacks: boolean;
  cacheTtl: "5m" | "1h";
  aiTimeoutMs: number;
  jobTimeoutMs: number;
  maxTokens: number;
  maxTokensCeiling: number;
  concurrency: number;
  jobMaxAttempts: number;
  teacherSignupCode: string | null;
  cookieSecure: boolean;
  maxUploadBytes: number;
  maxPages: number;
  maxScanBytes: number;
  maxScanPages: number;
  maxUploadFiles: number;
  maxKeyItems: number;
  /** Hosted agent: spending cap per session in US cents, per task type (doubled on the one retry after a cap is hit). */
  agentBudgetCents: { extract: number; grade: number; scan: number };
  /** Hosted agent: wall-clock limit of one session, inside the job's own limit. */
  agentSessionTimeoutMs: number;
  /** AGENT_KEEP_SESSIONS=1: keep sessions and their uploads for debugging instead of deleting them. */
  agentKeepSessions: boolean;
  /** Logged once when the server starts: settings it ignores (ANTHROPIC_MODEL). */
  startupWarnings: string[];
}

/** ANTHROPIC_MODEL is retired: the model is chosen in Settings → AI model. A value left in .env.local is ignored. */
export const ANTHROPIC_MODEL_RETIRED = "ANTHROPIC_MODEL is no longer used — choose the model on the Settings page.";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];
const MIB = 1_048_576;

const CONSTANTS = {
  jobTimeoutMs: 2_700_000,
  maxTokens: 64_000,
  maxTokensCeiling: 128_000,
  maxUploadFiles: 20,
  maxKeyItems: 200,
} as const;

function intVar(min: number, max: number, fallback: number) {
  return z.coerce.number().int().min(min).max(max).default(fallback);
}

const USD_MESSAGE = "must be a dollar amount between 0.10 and 50, such as 2 or 1.50";

/** US dollars with at most two decimals ("2", "1.50") → integer cents, 10…5000. */
function usdVar(fallback: string) {
  return z.string()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, USD_MESSAGE)
    .transform((value) => Math.round(Number(value) * 100))
    .refine((cents) => cents >= 10 && cents <= 5000, USD_MESSAGE)
    .prefault(fallback);
}

const appUrlVar = z.string().transform((value, ctx) => {
  const url = URL.canParse(value) ? new URL(value) : null;
  const isOrigin = url !== null && (url.protocol === "http:" || url.protocol === "https:")
    && url.pathname === "/" && url.search === "" && url.hash === "";
  if (!url || !isOrigin) {
    ctx.addIssue({ code: "custom", message: "must be an absolute http(s) origin such as https://grader.school.org" });
    return z.NEVER;
  }
  return url.origin;
});

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATA_DIR: z.string().default("./data"),
  APP_URL: appUrlVar.optional(),
  AI_MODE: z.enum(["claude", "fake"]).default("claude"),
  ALLOW_FAKE_AI: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  APP_SECRET: z.string().min(32, "must be at least 32 characters; generate one with: openssl rand -base64 32").optional(),
  // Retired: read only to warn that it is ignored (any value).
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_EFFORT: z.enum(EFFORTS).default("high"),
  AI_FALLBACKS: z.enum(["on", "off"]).default("on"),
  AI_CACHE_TTL: z.enum(["5m", "1h"]).default("1h"),
  AI_TIMEOUT_MS: intVar(10_000, Number.MAX_SAFE_INTEGER, 600_000),
  GRADING_CONCURRENCY: intVar(1, 8, 3),
  JOB_MAX_ATTEMPTS: intVar(1, 10, 4),
  // The code is the only thing between a stranger and a teacher account (and the API key), so no short words.
  TEACHER_SIGNUP_CODE: z.string().min(12, "must be at least 12 characters; use a random code").optional(),
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  MAX_UPLOAD_MB: intVar(1, 22, 20),
  MAX_PAGES: intVar(1, 200, 40),
  MAX_SCAN_MB: intVar(1, 200, 100),
  MAX_SCAN_PAGES: intVar(1, 500, 200),
  AGENT_BUDGET_EXTRACT_USD: usdVar("3.00"),
  AGENT_BUDGET_GRADE_USD: usdVar("2.00"),
  AGENT_BUDGET_SCAN_USD: usdVar("1.50"),
  AGENT_SESSION_TIMEOUT_MS: intVar(60_000, 2_700_000, 1_200_000),
  AGENT_KEEP_SESSIONS: z.enum(["0", "1"]).default("0"),
});

type EnvVar = keyof typeof EnvSchema.shape;

/** Reads the variables we know about; values are trimmed and empty strings count as unset. */
function readEnv(): Partial<Record<EnvVar, string>> {
  const env: Partial<Record<EnvVar, string>> = {};
  for (const name of Object.keys(EnvSchema.shape) as EnvVar[]) {
    const value = process.env[name]?.trim();
    if (value) env[name] = value;
  }
  return env;
}

function configError(problems: string[]): Error {
  return new Error(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

function parseConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(readEnv());
  if (!parsed.success) {
    throw configError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const env = parsed.data;
  if (env.AI_MODE === "fake" && env.NODE_ENV === "production" && env.ALLOW_FAKE_AI !== "1") {
    throw configError(["AI_MODE: fake grading is refused when NODE_ENV=production unless ALLOW_FAKE_AI=1"]);
  }
  const appUrl = env.APP_URL ?? null;
  return {
    nodeEnv: env.NODE_ENV,
    dataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), env.DATA_DIR),
    appUrl,
    aiMode: env.AI_MODE,
    hasApiKey: env.ANTHROPIC_API_KEY !== undefined,
    appSecret: env.APP_SECRET ?? null,
    effort: env.ANTHROPIC_EFFORT,
    fallbacks: env.AI_FALLBACKS === "on",
    cacheTtl: env.AI_CACHE_TTL,
    aiTimeoutMs: env.AI_TIMEOUT_MS,
    concurrency: env.GRADING_CONCURRENCY,
    jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
    teacherSignupCode: env.TEACHER_SIGNUP_CODE ?? null,
    cookieSecure: env.COOKIE_SECURE === "auto" ? (appUrl?.startsWith("https:") ?? false) : env.COOKIE_SECURE === "true",
    maxUploadBytes: env.MAX_UPLOAD_MB * MIB,
    maxPages: env.MAX_PAGES,
    maxScanBytes: env.MAX_SCAN_MB * MIB,
    maxScanPages: env.MAX_SCAN_PAGES,
    agentBudgetCents: { extract: env.AGENT_BUDGET_EXTRACT_USD, grade: env.AGENT_BUDGET_GRADE_USD, scan: env.AGENT_BUDGET_SCAN_USD },
    agentSessionTimeoutMs: env.AGENT_SESSION_TIMEOUT_MS,
    agentKeepSessions: env.AGENT_KEEP_SESSIONS === "1",
    startupWarnings: env.ANTHROPIC_MODEL === undefined ? [] : [ANTHROPIC_MODEL_RETIRED],
    ...CONSTANTS,
  };
}

let cached: AppConfig | null = null;

/** Parses and validates the environment on first use; throws an error listing every bad variable. */
export function getConfig(): AppConfig {
  cached ??= parseConfig();
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
