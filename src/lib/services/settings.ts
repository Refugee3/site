import { checkApiKey, resetGrader, setUpHostedAgentNow, startHostedAgentSetup, type KeyCheck } from "@/lib/ai";
import { maskApiKey, normalizeApiKeyInput } from "@/lib/ai/api-key";
import { getConfig } from "@/lib/config";
import {
  clearStoredApiKey, getAppSettings, setGradingEngine as storeGradingEngine, setStoredApiKey, setStudentsCanUpload,
} from "@/lib/db/repos/settings";
import { setGradingPreferences } from "@/lib/db/repos/teachers";
import { AppError } from "@/lib/errors";
import { charLength } from "@/lib/grading/text";
import { resumeWorker } from "@/lib/jobs/queue";
import { encryptSecret } from "@/lib/secrets";
import type { GradingEngineChoice, Teacher } from "@/lib/types";

// App-wide settings (the API key, the grading engine, the student switch) and the teacher's own grading preferences.

export const UPLOADS_OFF_MESSAGE = "Your teacher isn't accepting online submissions. Hand your paper to your teacher instead.";

export type KeyChecker = (key: string) => Promise<KeyCheck>;

export const MAX_GRADING_PREFERENCES = 4000;
const KEY_REJECTED = "Anthropic rejected this key. Check that you copied all of it and that it hasn't been revoked.";
const KEY_UNREACHABLE = "Key saved, but Anthropic couldn't be reached to check it. If the key is wrong, grading will pause and say so.";

/** "Students can upload their own work" (off unless a teacher turned it on). */
export function studentUploadsEnabled(): boolean {
  return getAppSettings().studentsCanUpload;
}

export function setStudentUploads(enabled: boolean): void {
  setStudentsCanUpload(enabled);
}

/**
 * Checks the pasted key with Anthropic, then stores it encrypted and switches grading over to it at once.
 * A key Anthropic rejects is not saved. One that couldn't be checked, or that can't use the model, is saved as
 * unverified, until a call made with it succeeds (confirmKeyOnSuccess). Returns the warning to show instead of the
 * plain success message, if any.
 */
export async function saveApiKey(teacher: Teacher, raw: string, check: KeyChecker = checkApiKey): Promise<{ warning: string | null }> {
  const input = normalizeApiKeyInput(raw);
  if (!input.ok) throw apiKeyError(input.error);
  // Before the check, so a server that can't store a key (a damaged secret.key) says so without calling Anthropic.
  const ciphertext = encryptSecret(input.key, "anthropic-api-key");
  // The network call runs outside any transaction.
  const result = await check(input.key);
  if (result === "rejected") throw apiKeyError(KEY_REJECTED);
  setStoredApiKey({
    ciphertext,
    masked: maskApiKey(input.key),
    check: result === "ok" ? "verified" : "unverified",
    setBy: teacher.id,
  });
  switchToCurrentKey();
  // In the background, so the hosted agent is usually ready before the first paper; the save doesn't wait for it.
  startHostedAgentSetup();
  return { warning: saveWarning(result) };
}

/** Grading falls back to the server's ANTHROPIC_API_KEY, if it has one. */
export function removeApiKey(): void {
  clearStoredApiKey();
  switchToCurrentKey();
}

/** The worker builds a grader from the current key on its next tick and runs the jobs a key problem paused. */
function switchToCurrentKey(): void {
  resetGrader();
  resumeWorker();
}

/**
 * Settings → Grader. Validated by the action; switches grading at once: the next job is built with the chosen engine,
 * jobs already running finish on the one they started with, and jobs a pause held back run again.
 */
export function setGradingEngine(engine: GradingEngineChoice): void {
  storeGradingEngine(engine);
  resetGrader();
  resumeWorker();
  if (engine === "agent") startHostedAgentSetup();
}

/** "Set up now" / "Set up again": on success also resumeWorker() (a pause for agent_unavailable ends). */
export async function setUpHostedAgentAgain(): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await setUpHostedAgentNow();
  if (result.ok) resumeWorker();
  return result;
}

function apiKeyError(message: string): AppError {
  return new AppError("validation", message, { fieldErrors: { apiKey: [message] } });
}

function saveWarning(result: Exclude<KeyCheck, "rejected">): string | null {
  switch (result) {
    case "ok":
      return null;
    case "model_unavailable":
      return `Key saved. It works, but the model ${getConfig().model} isn't available to it, so grading will pause until it is.`;
    case "unreachable":
      return KEY_UNREACHABLE;
  }
}

/** The teacher's standing notes for the grader, sent with every paper in all of their assignments. */
export function saveGradingPreferences(teacher: Teacher, text: string): void {
  const preferences = text.trim();
  if (charLength(preferences) > MAX_GRADING_PREFERENCES) {
    const message = `Use at most ${MAX_GRADING_PREFERENCES} characters.`;
    throw new AppError("validation", message, { fieldErrors: { gradingPreferences: [message] } });
  }
  setGradingPreferences(teacher.id, preferences);
}
