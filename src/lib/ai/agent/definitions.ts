import type {
  AgentCreateParams,
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsCustomToolInputSchema,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { EnvironmentCreateParams } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type * as z from "zod";
import { sha256Hex } from "@/lib/ids";
import type { AiModel, Effort } from "@/lib/types";
import { GradingOutputSchema, GradingOutputWithoutNotesSchema, KeyExtractionSchema, outputFormat, ScanPagesSchema } from "../schemas";
import type { Body } from "./port";
import {
  AGENT_GRADING_SYSTEM_PROMPT, AGENT_KEY_SYSTEM_PROMPT, AGENT_SCAN_SYSTEM_PROMPT, SUBMIT_GRADING_WITHOUT_NOTES,
  SUBMIT_GRADING_WITHOUT_NOTES_DESCRIPTION, SUBMIT_TOOL_DESCRIPTION,
} from "./prompts";

// What the app creates in the key's Anthropic workspace: one environment and one agent per task type. Each
// definition carries a hash of the fields that matter, so a changed prompt, model or effort updates the agent.

export const AGENT_ROLES = ["extract", "grade", "scan"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const SUBMIT_TOOL = { extract: "submit_answer_key", grade: "submit_grading", scan: "submit_scan_pages" } as const;
export const UPLOADS_DIR = "/mnt/session/uploads";
/** mount_path values (rooted under UPLOADS_DIR by the platform). */
export const MOUNT = { answerKey: "/answer-key.pdf", student: "/student-submission.pdf", scan: "/scanned-pages.pdf" } as const;
/** Bumped whenever the definition *code* changes in a way the hashed fields would not show. */
export const DEFINITIONS_REVISION = 1;

export interface AgentEngineConfig {
  /** Settings → AI model, for extract and grade: changing it updates those two agents (a new version, same ids). */
  model: AiModel;
  /** SCAN_SPLIT_MODEL (Sonnet 5.5), for the scan splitter whatever the choice. */
  scanModel: AiModel;
  /** ANTHROPIC_EFFORT, for extract and grade. */
  effort: Effort;
  /** SCAN_SPLIT_EFFORT ("medium"). */
  scanEffort: Effort;
  budgetCents: Record<AgentRole, number>;
  sessionTimeoutMs: number;
  keepSessions: boolean;
  /** The configured default max tokens; a call asking for more is the retry after a cap and gets double the budget. */
  maxTokens: number;
}
export interface AgentDefinition { role: AgentRole; hash: string; params: Body<AgentCreateParams> }
export interface EnvironmentDefinition { name: string; hash: string; params: Body<EnvironmentCreateParams> }

const APP = "pdf-autograder";

// Typed, not `as const`: a readonly tuple doesn't assign to the SDK's Array.
const TOOLSET: BetaManagedAgentsAgentToolset20260401Params = {
  type: "agent_toolset_20260401",
  default_config: { enabled: false, permission_policy: { type: "auto" } },
  configs: [
    { name: "bash", enabled: true },
    { name: "read", enabled: true },
    { name: "web_fetch", enabled: false },
    { name: "web_search", enabled: false },
  ],
};

const ROLE_NAME: Record<AgentRole, string> = { extract: "answer key reader", grade: "paper grader", scan: "scan splitter" };

const ROLE_DESCRIPTION: Record<AgentRole, string> = {
  extract: "Reads a teacher's answer-key PDF into gradable items for the PDF Auto-Grader. Managed by the app: changes made here are overwritten.",
  grade: "Grades one student's handwritten paper against the answer key for the PDF Auto-Grader. "
    + "Managed by the app: changes made here are overwritten.",
  scan: "Describes scanned pages so the PDF Auto-Grader can split a class's stack into papers. "
    + "Managed by the app: changes made here are overwritten.",
};

const SYSTEM_PROMPT: Record<AgentRole, string> = {
  extract: AGENT_KEY_SYSTEM_PROMPT,
  grade: AGENT_GRADING_SYSTEM_PROMPT,
  scan: AGENT_SCAN_SYSTEM_PROMPT,
};

const OUTPUT_SCHEMA: Record<AgentRole, z.ZodType> = { extract: KeyExtractionSchema, grade: GradingOutputSchema, scan: ScanPagesSchema };

/** The model a role's agent runs on: the scan splitter's own, else the one chosen in Settings. */
export function roleModel(cfg: Pick<AgentEngineConfig, "model" | "scanModel">, role: AgentRole): AiModel {
  return role === "scan" ? cfg.scanModel : cfg.model;
}

export function agentDefinition(
  role: AgentRole,
  cfg: Pick<AgentEngineConfig, "model" | "scanModel" | "effort" | "scanEffort">,
  installId: string,
): AgentDefinition {
  const name = `PDF Auto-Grader: ${ROLE_NAME[role]} [${installId}]`;
  const description = ROLE_DESCRIPTION[role];
  const model = { id: roleModel(cfg, role), effort: role === "scan" ? cfg.scanEffort : cfg.effort };
  const system = SYSTEM_PROMPT[role];
  const tools: NonNullable<AgentCreateParams["tools"]> = [
    TOOLSET,
    { type: "custom", name: SUBMIT_TOOL[role], description: SUBMIT_TOOL_DESCRIPTION[role], input_schema: submitToolSchema(role) },
    // The grader hands in a grading without notes with its own tool: a tool's schema is fixed when the agent is created.
    ...(role === "grade"
      ? [{
        type: "custom" as const,
        name: SUBMIT_GRADING_WITHOUT_NOTES,
        description: SUBMIT_GRADING_WITHOUT_NOTES_DESCRIPTION,
        input_schema: objectSchema(GradingOutputWithoutNotesSchema, SUBMIT_GRADING_WITHOUT_NOTES),
      }]
      : []),
  ];
  const hash = definitionHash({ name, description, model, system, tools });
  return {
    role,
    hash,
    params: { name, description, model, system, tools, metadata: { app: APP, role, install: installId, definition: hash.slice(0, 16) } },
  };
}

export function environmentDefinition(installId: string): EnvironmentDefinition {
  const name = `pdf-autograder-${installId}`;
  const description = "Workspace template for the PDF Auto-Grader's hosted agent. Created and managed by the app.";
  // No allowed_hosts (deny-by-default) and no packages: the tools the prompts use are pre-installed.
  const config = { type: "cloud", networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false } } as const;
  const hash = definitionHash({ name, description, config });
  return { name, hash, params: { name, description, config, metadata: { app: APP, install: installId } } };
}

/** sha256 hex of the canonical JSON (keys sorted recursively) of { revision: DEFINITIONS_REVISION, value }. */
export function definitionHash(value: unknown): string {
  return sha256Hex(JSON.stringify(canonical({ revision: DEFINITIONS_REVISION, value })));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

/**
 * The JSON Schema used as each submit tool's input_schema: outputFormat(schema).schema, returned as the SDK's
 * BetaManagedAgentsCustomToolInputSchema (from "@anthropic-ai/sdk/resources/beta/agents/agents") after a runtime
 * check that its `type` is "object" (throws otherwise). A plain Record<string, unknown> does not type-check there.
 */
export function submitToolSchema(role: AgentRole): BetaManagedAgentsCustomToolInputSchema {
  return objectSchema(OUTPUT_SCHEMA[role], SUBMIT_TOOL[role]);
}

function objectSchema(zodSchema: z.ZodType, tool: string): BetaManagedAgentsCustomToolInputSchema {
  const schema = outputFormat(zodSchema).schema;
  if (!isObjectSchema(schema)) throw new Error(`The ${tool} input schema must describe a JSON object.`);
  return schema;
}

function isObjectSchema(schema: Record<string, unknown>): schema is BetaManagedAgentsCustomToolInputSchema {
  return schema.type === "object";
}
