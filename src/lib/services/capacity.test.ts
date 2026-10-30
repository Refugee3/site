import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGrader } from "@/lib/ai";
import { OVERFLOW_EXTRA_PAPERS } from "@/lib/ai/overflow";
import { resetConfigForTests } from "@/lib/config";
import { getOllamaExtraUrls, getOverflowSettings } from "@/lib/db/repos/capacity";
import { setGradingEngine, setOllamaSettings, setOllamaSpeedSettings } from "@/lib/db/repos/settings";
import { AppError } from "@/lib/errors";
import { useTestDb } from "@/test/helpers";
import { parseOtherComputers, saveOtherComputers, saveOverflowSettings, testOtherComputers } from "./capacity";

const PRIMARY = "http://localhost:11434";

beforeEach(() => {
  useTestDb();
});

function errorsOf(fn: () => unknown): Record<string, string[]> | string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.extra.fieldErrors ?? e.message;
    throw e;
  }
  return undefined;
}

describe("other computers", () => {
  it("reads addresses one per line (or with commas), adds http:// and Ollama's port, drops repeats and this computer", () => {
    expect(parseOtherComputers("192.168.1.31\nhttp://192.168.1.32:11434/, 192.168.1.31\n\nhttp://localhost:11434", PRIMARY))
      .toEqual(["http://192.168.1.31:11434", "http://192.168.1.32:11434"]);
    expect(parseOtherComputers("https://gpu.school.edu/ollama", PRIMARY)).toEqual(["https://gpu.school.edu/ollama"]);
    expect(parseOtherComputers("  ", PRIMARY)).toEqual([]);
  });

  it("says which address isn't one", () => {
    expect(errorsOf(() => parseOtherComputers("192.168.1.31\nftp://x", PRIMARY))).toEqual({
      otherComputers: [expect.stringContaining('"ftp://x" isn\'t an address')],
    });
    expect(errorsOf(() => parseOtherComputers(Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}`).join("\n"), PRIMARY))).toEqual({
      otherComputers: ["Add at most 8 computers."],
    });
  });

  it("saves them, and the grader spreads papers over every computer", () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    setGradingEngine("ollama");
    setOllamaSettings({ baseUrl: PRIMARY, model: "qwen3.6:27b", numCtx: 16384 });
    setOllamaSpeedSettings({ imageMaxEdge: null, papersAtATime: 2 });
    saveOtherComputers({ otherComputers: "192.168.1.31\n192.168.1.32" });
    expect(getOllamaExtraUrls()).toEqual(["http://192.168.1.31:11434", "http://192.168.1.32:11434"]);
    expect(getGrader()?.parallel).toBe(2 * 3);
  });

  it("tests each address with the saved model", async () => {
    setOllamaSettings({ baseUrl: PRIMARY, model: "qwen3.6:27b", numCtx: 16384 });
    const checks = await testOtherComputers({ otherComputers: "10.0.0.2\n10.0.0.3\n10.0.0.4" }, async ({ baseUrl, model }) => {
      if (baseUrl.includes("10.0.0.2")) return { ok: true, version: "0.12.0", models: [], modelInstalled: true, fix: null };
      if (baseUrl.includes("10.0.0.3")) return { ok: true, version: "0.12.0", models: [], modelInstalled: false, fix: `Run: ollama pull ${model}` };
      return { ok: false, error: "Ollama isn't running there.", fix: "Start Ollama on that computer." };
    });
    expect(checks).toEqual([
      { url: "http://10.0.0.2:11434", ok: true, text: "Ready: qwen3.6:27b is downloaded there." },
      { url: "http://10.0.0.3:11434", ok: false, text: "Reachable, but: Run: ollama pull qwen3.6:27b" },
      { url: "http://10.0.0.4:11434", ok: false, text: "Ollama isn't running there. Start Ollama on that computer." },
    ]);
  });
});

describe("Claude overflow settings", () => {
  it("needs an API key to turn on, and can always be turned off", () => {
    expect(errorsOf(() => saveOverflowSettings({ enabled: "on", afterPapers: "30", monthlyCapUsd: "25" }))).toMatch(/API key/);
    saveOverflowSettings({ afterPapers: "30", monthlyCapUsd: "25" });
    expect(getOverflowSettings()).toEqual({ enabled: false, afterPapers: 30, monthlyCapUsd: 25 });
  });

  it("checks the numbers", () => {
    expect(errorsOf(() => saveOverflowSettings({ afterPapers: "0", monthlyCapUsd: "2.5" }))).toEqual({
      afterPapers: ["Enter 1 or more."], monthlyCapUsd: ["Enter whole dollars."],
    });
  });

  it("puts the overflow in front of Ollama once on, with a key", () => {
    vi.stubEnv("AI_MODE", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-test-key-000000000000");
    resetConfigForTests();
    setGradingEngine("ollama");
    setOllamaSpeedSettings({ imageMaxEdge: null, papersAtATime: 1 });
    saveOverflowSettings({ enabled: "on", afterPapers: "20", monthlyCapUsd: "20" });
    expect(getGrader()).toMatchObject({ engine: "ollama", parallel: 1 + OVERFLOW_EXTRA_PAPERS });
  });
});
