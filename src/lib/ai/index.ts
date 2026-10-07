import { getConfig } from "@/lib/config";
import { resolveApiKey } from "./api-key";
import { createClaudeGrader, createSdkKeyChecker, createSdkRunner, type KeyCheck } from "./claude";
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
  return createClaudeGrader(createSdkRunner(cfg, resolved.source === "app" ? resolved.key : undefined), cfg);
}
