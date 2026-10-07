import { describe, expect, it } from "vitest";
import { aiModelSavedMessage, AI_MODEL_NAME, DEFAULT_AI_MODEL, isAiModel, SCAN_SPLIT_MODEL } from "@/lib/ai-models";
import { AI_MODELS } from "@/lib/types";

describe("the AI models", () => {
  it("offers Sonnet 5.5 (the default) and Opus 5.5, and splits scans with Sonnet 5.5", () => {
    expect(AI_MODELS).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(DEFAULT_AI_MODEL).toBe("claude-sonnet-5-5");
    expect(SCAN_SPLIT_MODEL).toBe("claude-sonnet-5-5");
    expect(AI_MODEL_NAME).toEqual({ "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-opus-5-5": "Claude Opus 5.5" });
  });

  it("recognizes only the offered models", () => {
    expect(AI_MODELS.every(isAiModel)).toBe(true);
    for (const value of ["claude-opus-5", "claude-sonnet-5", "Claude Opus 5.5", "", null, undefined]) {
      expect(isAiModel(value), String(value)).toBe(false);
    }
  });

  it("names the model that grades from now on once the choice is saved", () => {
    expect(aiModelSavedMessage("claude-sonnet-5-5")).toBe("Saved. Papers graded from now on use Claude Sonnet 5.5.");
    expect(aiModelSavedMessage("claude-opus-5-5")).toBe("Saved. Papers graded from now on use Claude Opus 5.5.");
  });
});
