import { OLLAMA_MODEL_PREFIX } from "@/lib/ollama-settings";
import type { AiUsage } from "@/lib/types";

// What Claude calls cost, estimated from their token usage at list prices (the usage page and the Claude overflow's monthly cap).

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: Record<"5m" | "1h", number>;
}

/** List price with cache writes at 1.25× input for the 5-minute TTL and 2× for the 1-hour TTL. */
function listPrice(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: { "5m": input * 1.25, "1h": input * 2 } };
}

/**
 * USD per million tokens, for each model that can answer: the two in Settings → AI model (Sonnet 5.5 also splits
 * scans), and the models server-side fallbacks may hand a declined request to, which bill at their own prices.
 */
const PRICES_PER_MTOK = new Map<string, ModelPrice>([
  ["claude-sonnet-5-5", listPrice(2, 10, 0.2)],
  ["claude-opus-5-5", listPrice(4, 20, 0.2)],
  // Fallbacks: Sonnet 5 for Sonnet 5.5; Opus 5 or Opus 4.8 for Opus 5.5.
  ["claude-sonnet-5", listPrice(2, 10, 0.2)],
  ["claude-opus-5", listPrice(5, 25, 0.5)],
  ["claude-opus-4-8", listPrice(5, 25, 0.5)],
]);

/** Estimated cost of the usage, or null for a model without a known price. */
export function estimateCostUsd(u: AiUsage, model: string, ttl: "5m" | "1h"): number | null {
  // A model running on this computer through Ollama costs nothing per call.
  if (model.startsWith(OLLAMA_MODEL_PREFIX)) return 0;
  const price = PRICES_PER_MTOK.get(model);
  if (!price) return null;
  const dollarsPerMillion = u.inputTokens * price.input + u.outputTokens * price.output
    + u.cacheReadTokens * price.cacheRead + u.cacheWriteTokens * price.cacheWrite[ttl];
  return dollarsPerMillion / 1_000_000;
}
