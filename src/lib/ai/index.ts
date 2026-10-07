import Anthropic from "@anthropic-ai/sdk";
import { type AppConfig, getConfig } from "@/lib/config";
import {
  getGradingEngine, getHostedAgentState, markStoredApiKeyVerified, saveHostedAgentError, saveHostedAgentReady,
} from "@/lib/db/repos/settings";
import type { GraderEngine, HostedAgentStatusView } from "@/lib/types";
import type { AgentEngineConfig } from "./agent/definitions";
import { createAgentGrader } from "./agent/grader";
import { createSdkAgentPort } from "./agent/port";
import {
  hostedAgentStatus, type ProvisionDeps, setUpHostedAgentNow as setUpProvisionedNow, startHostedAgentSetup as startProvisioning,
} from "./agent/provision";
import { apiKeyFingerprint, envApiKey, resolveApiKey, type ResolvedApiKey } from "./api-key";
import {
  createClaudeGrader, createSdkKeyChecker, createSdkRunner, type KeyCheck, type MessageRunner, SCAN_SPLIT_EFFORT,
} from "./claude";
import { createFakeGrader } from "./fake";
import type { Grader } from "./grader";

export type { KeyCheck } from "./claude";

// Process-wide globalThis slot so separate module copies share it: instrumentation and route handlers
// may load separate module instances.
const SLOT = Symbol.for("pag.grader");

interface GraderSlot {
  grader: Grader | null;
}

const slots = globalThis as unknown as Record<symbol, GraderSlot | undefined>;

/**
 * The configured grader, or null in claude mode without any API key (the worker then pauses). Memoized
 * until resetGrader(), which saving or removing the key in Settings calls.
 */
export function getGrader(): Grader | null {
  slots[SLOT] ??= { grader: graderFromConfig() };
  return slots[SLOT].grader;
}

/** Forgets the grader (also one forced by a test), so the next getGrader() builds it from the current key. */
export function resetGrader(): void {
  delete slots[SLOT];
}

/** A Grader or null forces that value; undefined clears the slot so the next call derives it from config again. */
export function setGraderForTests(g: Grader | null | undefined): void {
  if (g === undefined) delete slots[SLOT];
  else slots[SLOT] = { grader: g };
}

/** Checks a candidate API key with Anthropic before it is saved. */
export function checkApiKey(key: string): Promise<KeyCheck> {
  return createSdkKeyChecker(getConfig())(key);
}

/** "fake" in AI_MODE=fake, null without a usable key, else the Settings choice. Never builds a grader or calls Anthropic. */
export function currentGraderEngine(): GraderEngine | null {
  if (getConfig().aiMode === "fake") return "fake";
  const resolved = resolveApiKey();
  if (resolved === null) return null;
  if (getGradingEngine() === "direct") return "direct";
  return agentKey(resolved) === null ? null : "agent";
}

/** Background setup for the current key; no-op unless AI_MODE=claude, a key resolves and the engine is "agent". Never throws. */
export function startHostedAgentSetup(): void {
  try {
    if (getGradingEngine() !== "agent") return;
    const deps = currentAgentDeps();
    if (deps !== null) startProvisioning(deps);
  } catch (e) {
    // The save that asked for it already succeeded; setup is tried again before the next paper anyway.
    console.error("[agent] couldn't start setting up the hosted agent", e);
  }
}

/**
 * Re-checks and sets up the hosted agent now (≤ 60 s). In AI_MODE=fake → { ok: false, error: "Practice mode (AI_MODE=fake)
 * doesn't use the hosted agent." }; without a key → { ok: false, error: "Add an API key first." }.
 */
export async function setUpHostedAgentNow(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (getConfig().aiMode === "fake") return { ok: false, error: "Practice mode (AI_MODE=fake) doesn't use the hosted agent." };
  const deps = currentAgentDeps();
  if (deps === null) return { ok: false, error: "Add an API key first." };
  return setUpProvisionedNow(deps);
}

/** null in AI_MODE=fake or without a usable key. Never throws. */
export function getHostedAgentStatus(): HostedAgentStatusView | null {
  try {
    const deps = currentAgentDeps();
    return deps === null ? null : hostedAgentStatus(deps);
  } catch (e) {
    console.error("[agent] couldn't read the hosted agent's status", e);
    return null;
  }
}

function graderFromConfig(): Grader | null {
  const cfg = getConfig();
  if (cfg.aiMode === "fake") return createFakeGrader();
  const resolved = resolveApiKey();
  if (resolved === null) return null;
  if (getGradingEngine() === "direct") {
    if (resolved.source === "env") return createClaudeGrader(createSdkRunner(cfg), cfg);
    return createClaudeGrader(confirmKeyOnSuccess(createSdkRunner(cfg, resolved.key), resolved.ciphertext), cfg);
  }
  const deps = agentDeps(cfg, resolved);
  if (deps === null) return null;
  return createAgentGrader({
    ...deps,
    // A saved key that couldn't be confirmed when it was saved is confirmed by the first task that succeeds with it.
    onFirstSuccess: resolved.source === "app" ? () => markStoredApiKeyVerified(resolved.ciphertext) : undefined,
  });
}

/** What the hosted agent needs for the key in use; null in AI_MODE=fake or without a usable key. */
function currentAgentDeps(): ProvisionDeps | null {
  const cfg = getConfig();
  if (cfg.aiMode === "fake") return null;
  const resolved = resolveApiKey();
  return resolved === null ? null : agentDeps(cfg, resolved);
}

/** The key the hosted agent sends. Always explicit: the SDK is never left to pick up ANTHROPIC_API_KEY or a token itself. */
function agentKey(resolved: ResolvedApiKey): string | null {
  return resolved.source === "app" ? resolved.key : envApiKey();
}

/** The hosted agent's dependencies for one API key; null when that key can't be read. */
function agentDeps(cfg: AppConfig, resolved: ResolvedApiKey): ProvisionDeps | null {
  const key = agentKey(resolved);
  if (key === null) return null;
  let fingerprint: string | null = null;
  const keyFingerprint = () => (fingerprint ??= apiKeyFingerprint(key));
  /**
   * A setup started with this key can finish after the teacher saved another one: its result must not overwrite the
   * new key's state (the new key's next task would re-check this key's ids and leave its own unused).
   */
  const stillCurrent = () => {
    const now = resolveApiKey();
    if (now !== null && agentKey(now) === key) return true;
    console.info("[agent] setup result for a replaced API key not saved");
    return false;
  };
  return {
    port: createSdkAgentPort(new Anthropic({ apiKey: key, authToken: null, maxRetries: 2, timeout: cfg.aiTimeoutMs })),
    store: {
      load: getHostedAgentState,
      saveReady(s) {
        if (stillCurrent()) saveHostedAgentReady(s);
      },
      saveError(message, progress) {
        if (stillCurrent()) saveHostedAgentError(message, progress);
      },
    },
    cfg: agentEngineConfig(cfg),
    keyFingerprint,
  };
}

function agentEngineConfig(cfg: AppConfig): AgentEngineConfig {
  return {
    model: cfg.model,
    effort: cfg.effort,
    scanEffort: SCAN_SPLIT_EFFORT,
    budgetCents: cfg.agentBudgetCents,
    sessionTimeoutMs: cfg.agentSessionTimeoutMs,
    keepSessions: cfg.agentKeepSessions,
    maxTokens: cfg.maxTokens,
  };
}

/**
 * Settings shows a saved key that couldn't be confirmed when it was saved (Anthropic unreachable, or the model not
 * available to it) as "Not confirmed yet"; the first call made with it that succeeds confirms it.
 */
export function confirmKeyOnSuccess(runner: MessageRunner, ciphertext: string): MessageRunner {
  let confirmed = false;
  return async (params, o) => {
    const message = await runner(params, o);
    if (!confirmed) {
      confirmed = true;
      try {
        markStoredApiKeyVerified(ciphertext);
      } catch (e) {
        // Only the badge in Settings depends on it; the answer the call paid for is kept.
        console.error("[ai] couldn't mark the saved API key as confirmed", e);
      }
    }
    return message;
  };
}
