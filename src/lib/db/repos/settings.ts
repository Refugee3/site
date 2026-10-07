import { randomBytes } from "node:crypto";
import * as z from "zod";
import { DEFAULT_AI_MODEL, isAiModel } from "@/lib/ai-models";
import { now } from "@/lib/clock";
import { one, run, toBit } from "@/lib/db/sql";
import { truncateChars } from "@/lib/grading/text";
import type { AiModel, GradingEngineChoice, HostedAgentRole } from "@/lib/types";

export interface AppSettings { studentsCanUpload: boolean; apiKeyCiphertext: string | null; apiKeyMasked: string | null;
  apiKeyCheck: "verified" | "unverified" | null; apiKeySetBy: string | null; apiKeySetAt: number | null; updatedAt: number;
  gradingEngine: GradingEngineChoice | null; aiModel: AiModel }

/** A hosted-agent object in the key's Anthropic workspace, with the hash of the definition it was last given. */
type StoredEnvironment = { id: string; hash: string };
type StoredAgent = { id: string; version: number; hash: string };

export interface HostedAgentState {
  installId: string;
  keyFp: string | null;
  environment: StoredEnvironment | null;
  agents: Partial<Record<HostedAgentRole, StoredAgent>>;
  status: "none" | "ready" | "error";
  error: string | null;
  checkedAt: number | null;
}

interface AppSettingsRow {
  id: 1;
  students_can_upload: 0 | 1;
  api_key_ciphertext: string | null;
  api_key_masked: string | null;
  api_key_check: "verified" | "unverified" | null;
  api_key_set_by: string | null;
  api_key_set_at: number | null;
  updated_at: number;
  grading_engine: GradingEngineChoice | null;
  agent_install_id: string | null;
  agent_key_fp: string | null;
  agent_environment_json: string | null;
  agent_agents_json: string | null;
  agent_status: HostedAgentState["status"];
  agent_error: string | null;
  agent_checked_at: number | null;
  ai_model: string;
}

const MAX_AGENT_ERROR_CHARS = 500;

const StoredEnvironmentSchema = z.object({ id: z.string(), hash: z.string() });
const StoredAgentSchema = z.object({ id: z.string(), version: z.number().int().min(1), hash: z.string() });
const StoredAgentsSchema = z.object({
  extract: StoredAgentSchema.optional(),
  grade: StoredAgentSchema.optional(),
  scan: StoredAgentSchema.optional(),
} satisfies Record<HostedAgentRole, z.ZodType>);

function settingsRow(): AppSettingsRow {
  return one<AppSettingsRow>("SELECT * FROM app_settings WHERE id = 1")!;
}

/** The single settings row (migration 3 inserts it). */
export function getAppSettings(): AppSettings {
  const row = settingsRow();
  return {
    studentsCanUpload: row.students_can_upload === 1,
    apiKeyCiphertext: row.api_key_ciphertext,
    apiKeyMasked: row.api_key_masked,
    apiKeyCheck: row.api_key_check,
    apiKeySetBy: row.api_key_set_by,
    apiKeySetAt: row.api_key_set_at,
    updatedAt: row.updated_at,
    gradingEngine: row.grading_engine,
    // The column's CHECK allows only the known models; anything else (never expected) reads as the default.
    aiModel: isAiModel(row.ai_model) ? row.ai_model : DEFAULT_AI_MODEL,
  };
}

export function setStudentsCanUpload(on: boolean): void {
  run("UPDATE app_settings SET students_can_upload = ?, updated_at = ? WHERE id = 1", toBit(on), now());
}

export function setStoredApiKey(k: { ciphertext: string; masked: string; check: "verified" | "unverified"; setBy: string }): void {
  const at = now();
  run(
    `UPDATE app_settings SET api_key_ciphertext = @ciphertext, api_key_masked = @masked, api_key_check = @check,
       api_key_set_by = @set_by, api_key_set_at = @at, updated_at = @at
     WHERE id = 1`,
    { ciphertext: k.ciphertext, masked: k.masked, check: k.check, set_by: k.setBy, at },
  );
}

/**
 * Marks the saved key confirmed once a call made with it succeeded. Only while that key (by its ciphertext) is still
 * the saved one and unconfirmed, so a call still running with an older key never vouches for a newer one.
 */
export function markStoredApiKeyVerified(ciphertext: string): boolean {
  return run(
    `UPDATE app_settings SET api_key_check = 'verified', updated_at = ?
     WHERE id = 1 AND api_key_ciphertext = ? AND api_key_check = 'unverified'`,
    now(), ciphertext,
  ) > 0;
}

export function clearStoredApiKey(): void {
  run(
    `UPDATE app_settings SET api_key_ciphertext = NULL, api_key_masked = NULL, api_key_check = NULL,
       api_key_set_by = NULL, api_key_set_at = NULL, updated_at = ?
     WHERE id = 1`,
    now(),
  );
}

export function setGradingEngine(engine: GradingEngineChoice): void {
  run("UPDATE app_settings SET grading_engine = ?, updated_at = ? WHERE id = 1", engine, now());
}

/** The effective choice: the stored one, else the default "direct" (NULL = never chosen, also on servers set up before v5). */
export function getGradingEngine(): GradingEngineChoice {
  return getAppSettings().gradingEngine ?? "direct";
}

/** Settings → AI model. */
export function setAiModel(model: AiModel): void {
  run("UPDATE app_settings SET ai_model = ?, updated_at = ? WHERE id = 1", model, now());
}

/** The model that reads answer keys and grades papers (migration 5 defaults it to Sonnet 5.5). */
export function getAiModel(): AiModel {
  return getAppSettings().aiModel;
}

/** A stored JSON column read with `schema`; null when unset, and null (with a warning) when it doesn't parse. */
function parseStoredJson<S extends z.ZodType>(column: string, json: string | null, schema: S): z.output<S> | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    value = undefined;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn(`[settings] app_settings.${column} is unreadable; treating it as empty`);
  return null;
}

/** Migration 4 gives every install its id; a row without one (never expected) gets one here, once. */
function ensureInstallId(): string {
  run(
    "UPDATE app_settings SET agent_install_id = ?, updated_at = ? WHERE id = 1 AND agent_install_id IS NULL",
    randomBytes(6).toString("hex"), now(),
  );
  return settingsRow().agent_install_id!;
}

export function getHostedAgentState(): HostedAgentState {
  const row = settingsRow();
  return {
    installId: row.agent_install_id ?? ensureInstallId(),
    keyFp: row.agent_key_fp,
    environment: parseStoredJson("agent_environment_json", row.agent_environment_json, StoredEnvironmentSchema),
    agents: parseStoredJson("agent_agents_json", row.agent_agents_json, StoredAgentsSchema) ?? {},
    status: row.agent_status,
    error: row.agent_error,
    checkedAt: row.agent_checked_at,
  };
}

/** status 'ready', error NULL, checked_at now; replaces key fp, environment and all agents. */
export function saveHostedAgentReady(s: {
  keyFp: string;
  environment: StoredEnvironment;
  agents: Record<HostedAgentRole, StoredAgent>;
}): void {
  const at = now();
  run(
    `UPDATE app_settings SET agent_status = 'ready', agent_error = NULL, agent_checked_at = @at, agent_key_fp = @key_fp,
       agent_environment_json = @environment_json, agent_agents_json = @agents_json, updated_at = @at
     WHERE id = 1`,
    { at, key_fp: s.keyFp, environment_json: JSON.stringify(s.environment), agents_json: JSON.stringify(s.agents) },
  );
}

/**
 * status 'error', error = message (trimmed, cut to 500 chars), checked_at now. With `progress`, also replaces key fp,
 * environment and agents (what setup managed to create before failing); without it, the stored ids are kept.
 */
export function saveHostedAgentError(message: string, progress?: {
  keyFp: string;
  environment: StoredEnvironment | null;
  agents: Partial<Record<HostedAgentRole, StoredAgent>>;
}): void {
  const at = now();
  const error = truncateChars(message.trim(), MAX_AGENT_ERROR_CHARS);
  if (!progress) {
    run(
      "UPDATE app_settings SET agent_status = 'error', agent_error = ?, agent_checked_at = ?, updated_at = ? WHERE id = 1",
      error, at, at,
    );
    return;
  }
  run(
    `UPDATE app_settings SET agent_status = 'error', agent_error = @error, agent_checked_at = @at, agent_key_fp = @key_fp,
       agent_environment_json = @environment_json, agent_agents_json = @agents_json, updated_at = @at
     WHERE id = 1`,
    {
      at,
      error,
      key_fp: progress.keyFp,
      environment_json: progress.environment === null ? null : JSON.stringify(progress.environment),
      agents_json: JSON.stringify(progress.agents),
    },
  );
}
