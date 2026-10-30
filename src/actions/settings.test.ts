import { refresh } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ai from "@/lib/ai";
import { getGrader } from "@/lib/ai/index";
import { requireTeacher } from "@/lib/auth/dal";
import { getAiModel, getAppSettings, getOllamaSpeedSettings, setGradingEngine } from "@/lib/db/repos/settings";
import type { AiModel } from "@/lib/types";
import { seedTeacher, useTestDb } from "@/test/helpers";
import { saveOllamaSettingsAction, setAiModelAction, setGradingEngineAction, testOllamaConnectionAction } from "./settings";

// Server actions read the session cookie through next/headers and refresh the page through next/cache, both of which
// need a live request: the signed-in teacher and refresh() are supplied here, and everything else runs for real.
vi.mock("@/lib/auth/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/dal")>()),
  requireTeacher: vi.fn(),
}));
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  refresh: vi.fn(),
}));

beforeEach(() => {
  useTestDb();
  vi.mocked(requireTeacher).mockResolvedValue(seedTeacher());
  vi.mocked(refresh).mockClear();
  vi.spyOn(ai, "startHostedAgentSetup").mockImplementation(() => undefined);
});

describe("setAiModelAction", () => {
  it("saves the model, says which one grades from now on, and refreshes the page", async () => {
    expect(await setAiModelAction("claude-opus-5-5")).toEqual({
      ok: true, message: "Saved. Papers graded from now on use Claude Opus 5.5.",
    });
    expect(getAiModel()).toBe("claude-opus-5-5");
    expect(refresh).toHaveBeenCalledTimes(1);

    expect(await setAiModelAction("claude-sonnet-5-5")).toEqual({
      ok: true, message: "Saved. Papers graded from now on use Claude Sonnet 5.5.",
    });
    expect(getAiModel()).toBe("claude-sonnet-5-5");
  });

  it("switches grading over at once, with either engine", async () => {
    const before = getGrader();
    await setAiModelAction("claude-opus-5-5");
    expect(getGrader()).not.toBe(before);
    setGradingEngine("agent");
    await setAiModelAction("claude-sonnet-5-5");
    expect(getAppSettings()).toMatchObject({ gradingEngine: "agent", aiModel: "claude-sonnet-5-5" });
  });

  it.each(["claude-opus-5", "claude-sonnet-5", "", null, 5])("refuses %j and changes nothing", async (value) => {
    expect(await setAiModelAction(value as AiModel)).toEqual({ ok: false, error: "Choose Claude Sonnet 5.5 or Claude Opus 5.5." });
    expect(getAiModel()).toBe("claude-sonnet-5-5");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("requires a signed-in teacher before anything else", async () => {
    vi.mocked(requireTeacher).mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(setAiModelAction("claude-opus-5-5")).rejects.toThrow("NEXT_REDIRECT");
    expect(getAiModel()).toBe("claude-sonnet-5-5");
  });
});

describe("setGradingEngineAction", () => {
  it("accepts Ollama on this computer and refuses anything else", async () => {
    expect(await setGradingEngineAction("ollama")).toEqual({
      ok: true,
      message: "Saved. The model on this computer (Ollama) grades from the next paper on; papers already being graded finish as they started.",
    });
    expect(getAppSettings().gradingEngine).toBe("ollama");
    expect(await setGradingEngineAction("local" as never)).toEqual({ ok: false, error: "Choose one of the graders." });
    expect(getAppSettings().gradingEngine).toBe("ollama");
  });
});

describe("saveOllamaSettingsAction", () => {
  function form(fields: Record<string, string>) {
    const fd = new FormData();
    for (const [name, value] of Object.entries(fields)) fd.set(name, value);
    return fd;
  }

  it("saves the form and refreshes the page", async () => {
    expect(await saveOllamaSettingsAction(null, form({ baseUrl: "http://localhost:11434", model: "qwen2.5vl:32b", numCtx: "24576" })))
      .toEqual({ ok: true, message: "Saved. Papers graded from now on use qwen2.5vl:32b on this computer." });
    expect(getAppSettings().ollama).toEqual({ baseUrl: "http://localhost:11434", model: "qwen2.5vl:32b", numCtx: 24_576 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("saves the page image size and papers at a time from the form", async () => {
    const fields = { baseUrl: "http://localhost:11434", model: "gemma3:27b", numCtx: "16384", imageMaxEdge: "", papersAtATime: "2" };
    expect(await saveOllamaSettingsAction(null, form(fields))).toMatchObject({ ok: true });
    expect(getOllamaSpeedSettings()).toEqual({ imageMaxEdge: null, papersAtATime: 2 });
  });

  it("returns field errors and saves nothing", async () => {
    const result = await saveOllamaSettingsAction(null, form({ baseUrl: "", model: "qwen2.5vl:7b", numCtx: "16384" }));
    expect(result).toMatchObject({ ok: false, fieldErrors: { baseUrl: [expect.any(String)] } });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("testOllamaConnectionAction", () => {
  it("says what is wrong with the address before trying it", async () => {
    expect(await testOllamaConnectionAction({ baseUrl: "localhost", model: "qwen2.5vl:7b" })).toEqual({
      ok: false, error: "Enter the address Ollama listens on, such as http://localhost:11434.",
    });
  });

  it("requires a signed-in teacher", async () => {
    vi.mocked(requireTeacher).mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(testOllamaConnectionAction({ baseUrl: "http://localhost:11434", model: "x" })).rejects.toThrow("NEXT_REDIRECT");
  });
});
