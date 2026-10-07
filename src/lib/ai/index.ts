import { getConfig } from "@/lib/config";
import { createClaudeGrader, createSdkRunner } from "./claude";
import { createFakeGrader } from "./fake";
import type { Grader } from "./grader";

// Process-wide globalThis slot so separate module copies share it: instrumentation and route handlers
// may load separate module instances.
const SLOT = Symbol.for("pag.grader");

interface GraderSlot {
  grader: Grader | null;
}

const slots = globalThis as unknown as Record<symbol, GraderSlot | undefined>;

/** The configured grader, or null in claude mode without ANTHROPIC_API_KEY (the worker then pauses). */
export function getGrader(): Grader | null {
  slots[SLOT] ??= { grader: graderFromConfig() };
  return slots[SLOT].grader;
}

/** A Grader or null forces that value; undefined clears the slot so the next call derives it from config again. */
export function setGraderForTests(g: Grader | null | undefined): void {
  if (g === undefined) delete slots[SLOT];
  else slots[SLOT] = { grader: g };
}

function graderFromConfig(): Grader | null {
  const cfg = getConfig();
  if (cfg.aiMode === "fake") return createFakeGrader();
  if (!cfg.hasApiKey) return null;
  return createClaudeGrader(createSdkRunner(cfg), cfg);
}
