import { now } from "@/lib/clock";
import { addOverflowSpend, countWaitingGradingJobs, getOllamaExtraUrls, getOverflowSettings, getOverflowSpend, monthKey } from "@/lib/db/repos/capacity";
import { createOverflowGrader, type OverflowPolicy } from "./overflow";
import Anthropic from "@anthropic-ai/sdk";
import { SCAN_SPLIT_MODEL } from "@/lib/ai-models";
import { type AppConfig, getConfig } from "@/lib/config";
import {
  getAiModel, getGradingEngine, getHostedAgentState, getOllamaSettings, getOllamaSpeedSettings, markStoredApiKeyVerified,
  saveHostedAgentError, saveHostedAgentReady,
} from "@/lib/db/repos/settings";
import { ollamaImageEdge } from "@/lib/ollama-settings";
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
import { createOllamaClient } from "./ollama/client";
import { createOllamaGrader } from "./ollama/grader";

export type { KeyCheck } from "./claude";

// Process-wide globalThis slot so separate module copies share it: instrumentation and route handlers
// may load separate module instances.
const SLOT = Symbol.for("pag.grader");

interface GraderSlot {
  grader: Grader | null;
}

const slots = globalThis as unknown as Record<symbol, GraderSlot | undefined>;

/**
 * The configured grader, or null in claude mode without any API key while a Claude engine is chosen (the worker then
 * pauses); Ollama on this computer needs no key. Memoized until resetGrader(), which saving or removing the key, or
 * choosing the engine, the model or Ollama's settings, in Settings calls.
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

/** Whether an API key is available (saved in Settings or ANTHROPIC_API_KEY), e.g. for the Claude overflow. Never calls Anthropic. */
export function resolveApiKeyPresent(): boolean {
  return getConfig().aiMode !== "fake" && resolveApiKey() !== null;
}

/** Checks a candidate API key with Anthropic before it is saved, against the model chosen in Settings. */
export function checkApiKey(key: string): Promise<KeyCheck> {
  return createSdkKeyChecker(getAiModel())(key);
}

/**
 * "fake" in AI_MODE=fake, "ollama" when Ollama on this computer is chosen (no key needed), null without a usable key, else
 * the Settings choice. Never builds a grader or calls Anthropic or Ollama.
 */
export function currentGraderEngine(): GraderEngine | null {
  if (getConfig().aiMode === "fake") return "fake";
  if (getGradingEngine() === "ollama") return "ollama";
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

/** setUpHostedAgentNow's answer while the direct API is chosen. */
export const HOSTED_AGENT_NOT_CHOSEN = "Choose the Anthropic-hosted agent under Grader first.";

/**
 * Re-checks and sets up the hosted agent now (≤ 60 s). In AI_MODE=fake → { ok: false, error: "Practice mode (AI_MODE=fake)
 * doesn't use the hosted agent." }; without a key → { ok: false, error: "Add an API key first." }; with the direct API
 * chosen → HOSTED_AGENT_NOT_CHOSEN (nothing is created in the key's workspace until the hosted agent is chosen).
 */
export async function setUpHostedAgentNow(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (getConfig().aiMode === "fake") return { ok: false, error: "Practice mode (AI_MODE=fake) doesn't use the hosted agent." };
  const deps = currentAgentDeps();
  if (deps === null) return { ok: false, error: "Add an API key first." };
  if (getGradingEngine() !== "agent") return { ok: false, error: HOSTED_AGENT_NOT_CHOSEN };
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
  if (getGradingEngine() === "ollama") return ollamaGrader(cfg);
  const resolved = resolveApiKey();
  if (resolved === null) return null;
  if (getGradingEngine() === "direct") return directGrader(cfg, resolved);
  const deps = agentDeps(cfg, resolved);
  const key = agentKey(resolved);
  if (deps === null || key === null) return null;
  // The agent reads each paper in its session; judging the transcriptions is text only, so it is the direct engine's
  // Messages API call, with the same key and the model chosen in Settings (read when each call starts).
  const judgeRunner = createSdkRunner(cfg, key);
  return createAgentGrader({
    ...deps,
    // A saved key that couldn't be confirmed when it was saved is confirmed by the first task that succeeds with it.
    onFirstSuccess: resolved.source === "app" ? () => markStoredApiKeyVerified(resolved.ciphertext) : undefined,
    currentModel: getAiModel,
    judge: (input, o) => createClaudeGrader(judgeRunner, { ...cfg, model: getAiModel() }).judgeSubmission(input, o),
    // Mark detection's crops and a scanned blank's spots: the same text-and-image Messages API calls as the direct engine.
    transcribe: (input, o) => createClaudeGrader(judgeRunner, { ...cfg, model: getAiModel() }).transcribeCrops!(input, o),
    propose: (input, o) => createClaudeGrader(judgeRunner, { ...cfg, model: getAiModel() }).proposeSpots!(input, o),
  });
}

/**
 * Ollama on this computer, with the address, model, context size, page image size and papers at a time saved in Settings →
 * Grader. The image size falls back to OLLAMA_IMAGE_MAX_EDGE, then to the model family's (ollamaImageEdge); papers at a
 * time to OLLAMA_CONCURRENCY. The grader sends that many calls at once, and the worker grades that many papers at once.
 */
function ollamaGrader(cfg: AppConfig): Grader {
  const settings = getOllamaSettings();
  const speed = getOllamaSpeedSettings();
  const local = createOllamaGrader({
    client: createOllamaClient({ baseUrl: settings.baseUrl }),
    // Other computers running Ollama (Settings → Grader): papers are spread over all of them.
    extraClients: getOllamaExtraUrls().filter((url) => url !== settings.baseUrl).map((baseUrl) => createOllamaClient({ baseUrl })),
    cfg: {
      model: settings.model,
      numCtx: settings.numCtx,
      imageMaxEdge: ollamaImageEdge(settings.model, { setting: speed.imageMaxEdge, env: cfg.ollamaImageMaxEdge }),
      pagesPerCall: cfg.ollamaPagesPerCall,
      timeoutMs: cfg.ollamaTimeoutMs,
      maxPages: Math.max(cfg.maxPages, cfg.maxScanPages),
      concurrency: speed.papersAtATime ?? cfg.ollamaConcurrency,
      cropsPerCall: cfg.ollamaCropsPerCall,
    },
  });
  // The Claude overflow (Settings → Grader), with the saved API key: built only when it is first needed.
  if (!getOverflowSettings().enabled) return local;
  const resolved = resolveApiKey();
  if (resolved === null) return local;
  let claude: Grader | undefined;
  return createOverflowGrader({ local, claude: () => (claude ??= directGrader(cfg, resolved)), policy: overflowPolicy() });
}

/** The direct Messages API grader with the key `resolved` and the model chosen in Settings. */
function directGrader(cfg: AppConfig, resolved: NonNullable<ReturnType<typeof resolveApiKey>>): Grader {
  const direct = { ...cfg, model: getAiModel() };
  if (resolved.source === "env") return createClaudeGrader(createSdkRunner(cfg), direct);
  return createClaudeGrader(confirmKeyOnSuccess(createSdkRunner(cfg, resolved.key), resolved.ciphertext), direct);
}

/** Overflow to Claude while more papers wait than the setting says, until the month's cap is spent (read at every call). */
export function overflowPolicy(): OverflowPolicy {
  return {
    allowed() {
      const s = getOverflowSettings();
      if (!s.enabled) return false;
      const at = now();
      if (countWaitingGradingJobs(at) <= s.afterPapers) return false;
      return getOverflowSpend(monthKey(at)).microUsd < s.monthlyCapUsd * 1_000_000;
    },
    spent(costUsd, paper) {
      addOverflowSpend(monthKey(now()), costUsd * 1_000_000, paper ? 1 : 0);
    },
  };
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

/** Read at each use, so the definitions follow the model chosen in Settings (a change updates the agents, by hash). */
function agentEngineConfig(cfg: AppConfig): AgentEngineConfig {
  return {
    model: getAiModel(),
    scanModel: SCAN_SPLIT_MODEL,
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
