import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as ai from "@/lib/ai";
import type { KeyCheck } from "@/lib/ai";
import { createFakeGrader } from "@/lib/ai/fake";
import { getGrader, setGraderForTests } from "@/lib/ai/index";
import { setClockForTests } from "@/lib/clock";
import { getConfig, resetConfigForTests } from "@/lib/config";
import {
  getAiModel, getAppSettings, getOllamaSpeedSettings, setGradingEngine as storeGradingEngine, setStoredApiKey,
} from "@/lib/db/repos/settings";
import { getGradingPreferences } from "@/lib/db/repos/teachers";
import { attemptWithData } from "@/lib/http/action-result";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { DEFAULT_OLLAMA_SETTINGS } from "@/lib/ollama-settings";
import {
  checkOllamaConnection, removeApiKey, saveApiKey, saveGradingPreferences, saveOllamaSettings, setAiModel, setGradingEngine,
  setUpHostedAgentAgain, type KeyChecker,
} from "@/lib/services/settings";
import type { Teacher } from "@/lib/types";
import { seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-a1b2";
let teacher: Teacher;
/** Setting up the hosted agent would call Anthropic: the tests only see that it was started. */
let hostedAgentSetup: MockInstance<typeof ai.startHostedAgentSetup>;

beforeEach(() => {
  setClockForTests(() => T0);
  hostedAgentSetup = vi.spyOn(ai, "startHostedAgentSetup").mockImplementation(() => undefined);
  hostedAgentSetup.mockClear();
  useTestDb();
  teacher = seedTeacher();
});

function checker(result: KeyCheck) {
  return vi.fn<KeyChecker>(async () => result);
}

/** A saved key, as saveApiKey would store it (without asking Anthropic). */
function setStoredApiKeyForTest() {
  setStoredApiKey({ ciphertext: encryptSecret(KEY, "anthropic-api-key"), masked: "sk-ant-…a1b2", check: "verified", setBy: teacher.id });
}

/** A stand-in worker in the process-wide slot, so the service's resumeWorker() reaches it. */
function registerWorker() {
  const resume = vi.fn();
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pag.worker")] = {
    kick: () => {}, status: () => null, resume, stop: async () => {},
  };
  return resume;
}

describe("saveApiKey", () => {
  it("checks the trimmed key, stores it encrypted and masked, and says nothing more when it works", async () => {
    const check = checker("ok");

    expect(await saveApiKey(teacher, `  ${KEY}\n`, check)).toEqual({ warning: null });

    expect(check).toHaveBeenCalledWith(KEY);
    const settings = getAppSettings();
    expect(settings).toMatchObject({ apiKeyMasked: "sk-ant-…a1b2", apiKeyCheck: "verified", apiKeySetBy: teacher.id, apiKeySetAt: T0 });
    expect(settings.apiKeyCiphertext).not.toContain(KEY);
    expect(decryptSecret(settings.apiKeyCiphertext!, "anthropic-api-key")).toBe(KEY);
  });

  it("saves a key whose model isn't available, with a warning naming the chosen model, as not confirmed yet", async () => {
    expect(await saveApiKey(teacher, KEY, checker("model_unavailable"))).toEqual({
      warning: "Key saved. It works, but the model claude-sonnet-5-5 isn't available to it, so grading will pause until it is.",
    });
    // Settings keeps saying so after a reload, until a call with the key succeeds.
    expect(getAppSettings().apiKeyCheck).toBe("unverified");

    setAiModel("claude-opus-5-5");
    expect(await saveApiKey(teacher, KEY, checker("model_unavailable"))).toEqual({
      warning: "Key saved. It works, but the model claude-opus-5-5 isn't available to it, so grading will pause until it is.",
    });
  });

  it("saves a key that couldn't be checked as unverified, with a warning", async () => {
    expect(await saveApiKey(teacher, KEY, checker("unreachable"))).toEqual({
      warning: "Key saved, but Anthropic couldn't be reached to check it. If the key is wrong, grading will pause and say so.",
    });
    expect(getAppSettings()).toMatchObject({ apiKeyCheck: "unverified", apiKeyMasked: "sk-ant-…a1b2" });
  });

  it("saves nothing when Anthropic rejects the key", async () => {
    const message = "Anthropic rejected this key. Check that you copied all of it and that it hasn't been revoked.";
    const resume = registerWorker();

    await expect(saveApiKey(teacher, KEY, checker("rejected"))).rejects.toMatchObject({
      code: "validation", message, extra: { fieldErrors: { apiKey: [message] } },
    });
    expect(getAppSettings()).toMatchObject({ apiKeyCiphertext: null, apiKeyMasked: null, apiKeyCheck: null });
    expect(resume).not.toHaveBeenCalled();
  });

  it.each([
    ["", "Paste your API key."],
    ["sk-ant-admin01-abcdefghijklmnopqrstuvwxyz", "That's an Admin API key. Use a regular API key from Console → API keys."],
    ["sk-ant-api03 with spaces in it", "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."],
  ])("refuses %j before asking Anthropic", async (raw, message) => {
    const check = checker("ok");
    await expect(saveApiKey(teacher, raw, check)).rejects.toMatchObject({
      code: "validation", message, extra: { fieldErrors: { apiKey: [message] } },
    });
    expect(check).not.toHaveBeenCalled();
    expect(getAppSettings().apiKeyCiphertext).toBeNull();
  });

  it("tells the teacher what the server needs when its secret key file is damaged, without asking Anthropic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(path.join(getConfig().dataDir, "secret.key"), Buffer.alloc(0));
    const check = checker("ok");

    expect(await attemptWithData(() => saveApiKey(teacher, KEY, check))).toEqual({
      ok: false,
      error: "The server's secret key file (DATA_DIR/secret.key) is damaged, so API keys can't be saved. "
        + "Ask whoever runs this server to restore it from a backup or set APP_SECRET.",
    });
    expect(check).not.toHaveBeenCalled();
    expect(getAppSettings().apiKeyCiphertext).toBeNull();
  });

  it("drops the memoized grader and resumes the worker, so grading switches to the new key at once", async () => {
    const forced = createFakeGrader({ delayMs: 0 });
    setGraderForTests(forced);
    const resume = registerWorker();

    await saveApiKey(teacher, KEY, checker("ok"));

    expect(getGrader()).not.toBe(forced);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("gives a server without any key a Claude grader", async () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    expect(getGrader()).toBeNull();

    await saveApiKey(teacher, KEY, checker("ok"));

    // Built, never called: nothing touches the network.
    expect(getGrader()?.mode).toBe("claude");
  });

  it("asks for the hosted agent's setup for the new key, after switching grading over to it", async () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    // startHostedAgentSetup() itself does nothing unless the hosted agent is chosen (see ai/index.test.ts).
    storeGradingEngine("agent");
    hostedAgentSetup.mockImplementation(() => {
      // The setup must find the new key in place.
      expect(getAppSettings().apiKeyMasked).toBe("sk-ant-…a1b2");
      expect(getGrader()?.engine).toBe("agent");
    });

    await saveApiKey(teacher, KEY, checker("unreachable"));

    expect(hostedAgentSetup).toHaveBeenCalledTimes(1);
  });

  it("starts no setup for a key Anthropic rejects", async () => {
    await expect(saveApiKey(teacher, KEY, checker("rejected"))).rejects.toMatchObject({ code: "validation" });
    expect(hostedAgentSetup).not.toHaveBeenCalled();
  });
});

describe("setGradingEngine", () => {
  it("stores the choice, rebuilds the grader with it and resumes the worker", () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    setStoredApiKeyForTest();
    // The direct API until a teacher chooses.
    expect(getGrader()?.engine).toBe("direct");
    const resume = registerWorker();

    setGradingEngine("agent");

    expect(getAppSettings().gradingEngine).toBe("agent");
    expect(getGrader()?.engine).toBe("agent");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(hostedAgentSetup).toHaveBeenCalledTimes(1);

    setGradingEngine("direct");

    expect(getAppSettings().gradingEngine).toBe("direct");
    expect(getGrader()?.engine).toBe("direct");
    expect(resume).toHaveBeenCalledTimes(2);
    expect(hostedAgentSetup).toHaveBeenCalledTimes(1);
  });

  it("drops a grader forced by a test, so the next job is built with the choice", () => {
    const forced = createFakeGrader({ delayMs: 0 });
    setGraderForTests(forced);
    setGradingEngine("direct");
    expect(getGrader()).not.toBe(forced);
  });
});

describe("Ollama on this computer", () => {
  it("choosing it needs no key, sets up nothing at Anthropic, and resumes the worker", () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    expect(getGrader()).toBeNull();
    const resume = registerWorker();

    setGradingEngine("ollama");

    expect(getAppSettings().gradingEngine).toBe("ollama");
    expect(getGrader()).toMatchObject({ mode: "claude", engine: "ollama" });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(hostedAgentSetup).not.toHaveBeenCalled();
  });

  it("saves the validated address, model and context size, and switches grading over to them", () => {
    const resume = registerWorker();
    const before = getGrader();
    expect(saveOllamaSettings({ baseUrl: " http://127.0.0.1:11434/ ", model: " gemma3:12b ", numCtx: "32768" }))
      .toEqual({ baseUrl: "http://127.0.0.1:11434", model: "gemma3:12b", numCtx: 32_768 });
    expect(getAppSettings().ollama).toEqual({ baseUrl: "http://127.0.0.1:11434", model: "gemma3:12b", numCtx: 32_768 });
    expect(getGrader()).not.toBe(before);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("saves the page image size and papers at a time with them; empty means automatic and OLLAMA_CONCURRENCY", () => {
    const base = { baseUrl: "http://localhost:11434", model: "gemma3:27b", numCtx: "16384" };
    saveOllamaSettings({ ...base, imageMaxEdge: "1024", papersAtATime: "2" });
    expect(getOllamaSpeedSettings()).toEqual({ imageMaxEdge: 1024, papersAtATime: 2 });
    expect(getGrader()).toMatchObject({ engine: "fake" }); // practice mode; the Ollama grader is built in claude mode
    saveOllamaSettings({ ...base, imageMaxEdge: "", papersAtATime: "" });
    expect(getOllamaSpeedSettings()).toEqual({ imageMaxEdge: null, papersAtATime: null });
  });

  it("refuses a bad page image size or papers at a time, and saves nothing", async () => {
    const base = { baseUrl: "http://localhost:11434", model: "gemma3:27b", numCtx: "16384" };
    const result = await attemptWithData(() => saveOllamaSettings({ ...base, imageMaxEdge: "100", papersAtATime: "9" }));
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: {
        imageMaxEdge: ["Enter a page image size from 512 to 4096 pixels, or leave it empty for automatic."],
        papersAtATime: ["Choose from 1 to 4 papers at a time."],
      },
    });
    expect(getAppSettings().ollama).toEqual(DEFAULT_OLLAMA_SETTINGS);
    expect(getOllamaSpeedSettings()).toEqual({ imageMaxEdge: null, papersAtATime: null });
  });

  it("refuses bad settings field by field and saves nothing", async () => {
    const result = await attemptWithData(() => saveOllamaSettings({ baseUrl: "localhost:11434", model: "qwen 2.5", numCtx: "100" }));
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: {
        baseUrl: ["Enter the address Ollama listens on, such as http://localhost:11434."],
        model: [expect.stringContaining("Enter a model name")],
        numCtx: ["Enter a context size from 4096 to 131072."],
      },
    });
    expect(getAppSettings().ollama).toEqual(DEFAULT_OLLAMA_SETTINGS);
  });

  it("tests the typed address; a working Ollama ends a pause only while it grades", async () => {
    const resume = registerWorker();
    const reachable = vi.fn(async () => ({ ok: true as const, version: "0.40.7", models: [], modelInstalled: true, fix: null }));
    const input = { baseUrl: "http://localhost:11434", model: "qwen2.5vl:7b" };

    expect(await checkOllamaConnection(input, reachable)).toMatchObject({ ok: true });
    expect(reachable).toHaveBeenCalledWith(input);
    expect(resume).not.toHaveBeenCalled();

    storeGradingEngine("ollama");
    await checkOllamaConnection(input, reachable);
    expect(resume).toHaveBeenCalledTimes(1);

    const missingModel = vi.fn(async () => ({
      ok: true as const, version: "0.40.7", models: [], modelInstalled: false, fix: "Run: ollama pull qwen2.5vl:7b",
    }));
    await checkOllamaConnection(input, missingModel);
    expect(resume).toHaveBeenCalledTimes(1);

    await expect(checkOllamaConnection({ ...input, baseUrl: "nope" }, reachable)).rejects.toMatchObject({ code: "validation" });
  });
});

describe("setAiModel", () => {
  it("stores the choice, rebuilds the grader with it, resumes the worker and asks for the hosted agent's update", () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    setStoredApiKeyForTest();
    const before = getGrader();
    const resume = registerWorker();

    setAiModel("claude-opus-5-5");

    expect(getAiModel()).toBe("claude-opus-5-5");
    expect(getGrader()).not.toBe(before);
    expect(getGrader()?.engine).toBe("direct");
    expect(resume).toHaveBeenCalledTimes(1);
    // A no-op unless the hosted agent is chosen; then its agents are moved to the model in the background.
    expect(hostedAgentSetup).toHaveBeenCalledTimes(1);

    setAiModel("claude-sonnet-5-5");
    expect(getAiModel()).toBe("claude-sonnet-5-5");
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("leaves the engine and the key alone", () => {
    setStoredApiKeyForTest();
    setGradingEngine("agent");
    const settings = getAppSettings();

    setAiModel("claude-opus-5-5");

    expect(getAppSettings()).toEqual({ ...settings, aiModel: "claude-opus-5-5" });
  });
});

describe("setUpHostedAgentAgain", () => {
  it("says the practice grader doesn't use the hosted agent, and resumes nothing", async () => {
    const resume = registerWorker();
    expect(await setUpHostedAgentAgain()).toEqual({ ok: false, error: "Practice mode (AI_MODE=fake) doesn't use the hosted agent." });
    expect(resume).not.toHaveBeenCalled();
  });

  it("asks for a key first in claude mode without one", async () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    expect(await setUpHostedAgentAgain()).toEqual({ ok: false, error: "Add an API key first." });
  });

  it("resumes the worker once the hosted agent is set up, so a pause for it ends", async () => {
    const resume = registerWorker();
    const setUp = vi.spyOn(ai, "setUpHostedAgentNow");
    try {
      setUp.mockResolvedValueOnce({ ok: false, error: "This API key isn't allowed to use Claude Managed Agents." });
      expect(await setUpHostedAgentAgain()).toEqual({ ok: false, error: "This API key isn't allowed to use Claude Managed Agents." });
      expect(resume).not.toHaveBeenCalled();

      setUp.mockResolvedValueOnce({ ok: true });
      expect(await setUpHostedAgentAgain()).toEqual({ ok: true });
      expect(resume).toHaveBeenCalledTimes(1);
    } finally {
      setUp.mockRestore();
    }
  });
});

describe("removeApiKey", () => {
  it("clears the saved key, drops the grader and resumes the worker", async () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
    await saveApiKey(teacher, KEY, checker("ok"));
    expect(getGrader()).not.toBeNull();
    const resume = registerWorker();

    removeApiKey();

    expect(getAppSettings()).toMatchObject({
      apiKeyCiphertext: null, apiKeyMasked: null, apiKeyCheck: null, apiKeySetBy: null, apiKeySetAt: null,
    });
    expect(getGrader()).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe("saveGradingPreferences", () => {
  it("stores the trimmed text, up to 4000 characters", () => {
    saveGradingPreferences(teacher, "  Ignore spelling.\n");
    expect(getGradingPreferences(teacher.id)).toBe("Ignore spelling.");

    saveGradingPreferences(teacher, "é".repeat(4000));
    expect(getGradingPreferences(teacher.id)).toHaveLength(4000);
  });

  it("refuses more than 4000 characters", () => {
    const message = "Use at most 4000 characters.";
    expect(() => saveGradingPreferences(teacher, "x".repeat(4001))).toThrow(expect.objectContaining({
      code: "validation", message, extra: { fieldErrors: { gradingPreferences: [message] } },
    }));
    expect(getGradingPreferences(teacher.id)).toBe("");
  });
});
