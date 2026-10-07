import { refresh } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ai from "@/lib/ai";
import { getGrader } from "@/lib/ai/index";
import { requireTeacher } from "@/lib/auth/dal";
import { getAiModel, getAppSettings, setGradingEngine } from "@/lib/db/repos/settings";
import type { AiModel } from "@/lib/types";
import { seedTeacher, useTestDb } from "@/test/helpers";
import { setAiModelAction } from "./settings";

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
