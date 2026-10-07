import { getConfig } from "@/lib/config";
import { markStoredApiKeyVerified } from "@/lib/db/repos/settings";
import { resolveApiKey } from "./api-key";
import { createClaudeGrader, createSdkKeyChecker, createSdkRunner, type KeyCheck, type MessageRunner } from "./claude";
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

function graderFromConfig(): Grader | null {
  const cfg = getConfig();
  if (cfg.aiMode === "fake") return createFakeGrader();
  const resolved = resolveApiKey();
  if (resolved === null) return null;
  if (resolved.source === "env") return createClaudeGrader(createSdkRunner(cfg), cfg);
  return createClaudeGrader(confirmKeyOnSuccess(createSdkRunner(cfg, resolved.key), resolved.ciphertext), cfg);
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
