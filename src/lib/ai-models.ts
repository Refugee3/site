import { AI_MODELS, type AiModel } from "@/lib/types";

// The models a teacher can choose in Settings → AI model, shared by the server and the pages (client-safe: no
// server imports).

/** New servers, and servers upgraded from before the choice existed, grade with Sonnet 5.5. */
export const DEFAULT_AI_MODEL: AiModel = AI_MODELS[0];

/** Splitting a whole-class scan only needs page-level reading: it always uses Sonnet 5.5, whatever the choice. */
export const SCAN_SPLIT_MODEL: AiModel = "claude-sonnet-5-5";

export const AI_MODEL_NAME: Record<AiModel, string> = {
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-5-5": "Claude Opus 5.5",
};

export function isAiModel(value: unknown): value is AiModel {
  return (AI_MODELS as readonly unknown[]).includes(value);
}

/** setAiModelAction's message once the choice is saved. */
export function aiModelSavedMessage(model: AiModel): string {
  return `Saved. Papers graded from now on use ${AI_MODEL_NAME[model]}.`;
}
