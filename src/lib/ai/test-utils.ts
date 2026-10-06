import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AppConfig } from "@/lib/config";
import type { AiUsage, KeyItem, Section } from "@/lib/types";

// Tests only. makeMessage builds what a MessageRunner would return, so no real client is ever constructed.

/** A complete AppConfig that does not read the environment. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test", dataDir: "/tmp/pag-test", appUrl: null, aiMode: "claude", hasApiKey: true, model: "claude-opus-5-5",
    effort: "high", fallbacks: true, cacheTtl: "1h", aiTimeoutMs: 600_000, jobTimeoutMs: 2_700_000, maxTokens: 64_000,
    maxTokensCeiling: 128_000, concurrency: 3, jobMaxAttempts: 4, teacherSignupCode: null, cookieSecure: false,
    maxUploadBytes: 20 * 1_048_576, maxPages: 40, maxUploadFiles: 20, maxKeyItems: 200, ...overrides,
  };
}

export function makeKeyItem(overrides: Partial<KeyItem> = {}): KeyItem {
  return {
    id: "00000000-0000-4000-8000-000000000001", assignmentId: "00000000-0000-4000-8000-0000000000aa", position: 0,
    label: "1", groupLabel: "", prompt: "", answerType: "short_answer", expectedAnswer: "", acceptableAnswers: [],
    gradingCriteria: "", pointsCenti: 100, partialCredit: true, page: null, answerSource: "teacher", aiConfidence: null, aiNote: "",
    ...overrides,
  };
}

export function makeSection(overrides: Partial<Section> = {}): Section {
  return {
    id: "00000000-0000-4000-8000-0000000000b1", assignmentId: "00000000-0000-4000-8000-0000000000aa", label: "Period 1",
    aliases: [], canonicalKey: "1", sortOrder: 0, ...overrides,
  };
}

export function makeMessage(o: {
  stopReason?: string;
  text?: string;
  model?: string;
  content?: unknown[];
  usage?: Partial<AiUsage>;
  category?: string | null;
} = {}): BetaMessage {
  const content = o.content ?? (o.text === undefined ? [] : [{ type: "text", text: o.text, citations: null }]);
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: o.model ?? "claude-opus-5-5",
    container: null,
    context_management: null,
    diagnostics: null,
    content: content as BetaMessage["content"],
    stop_reason: (o.stopReason ?? "end_turn") as BetaMessage["stop_reason"],
    stop_sequence: null,
    stop_details: o.category === undefined ? null : {
      type: "refusal",
      category: o.category as NonNullable<BetaMessage["stop_details"]>["category"],
      explanation: null,
      fallback_credit_token: null,
      fallback_has_prefill_claim: null,
      recommended_model: null,
    },
    usage: {
      input_tokens: o.usage?.inputTokens ?? 0,
      output_tokens: o.usage?.outputTokens ?? 0,
      cache_read_input_tokens: o.usage?.cacheReadTokens ?? 0,
      cache_creation_input_tokens: o.usage?.cacheWriteTokens ?? 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
      speed: null,
    },
  };
}
