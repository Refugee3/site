import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as ai from "@/lib/ai";
import type { KeyCheck } from "@/lib/ai";
import { createFakeGrader } from "@/lib/ai/fake";
import { getGrader, setGraderForTests } from "@/lib/ai/index";
import { setClockForTests } from "@/lib/clock";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { getAppSettings, setStoredApiKey } from "@/lib/db/repos/settings";
import { getGradingPreferences } from "@/lib/db/repos/teachers";
import { attemptWithData } from "@/lib/http/action-result";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  removeApiKey, saveApiKey, saveGradingPreferences, setGradingEngine, setStudentUploads, setUpHostedAgentAgain, studentUploadsEnabled,
  UPLOADS_OFF_MESSAGE, type KeyChecker,
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

describe("the student switch", () => {
  it("starts off and can be turned on and off", () => {
    expect(studentUploadsEnabled()).toBe(false);
    setStudentUploads(true);
    expect(studentUploadsEnabled()).toBe(true);
    setStudentUploads(false);
    expect(studentUploadsEnabled()).toBe(false);
  });

  it("tells students to hand in their paper", () => {
    expect(UPLOADS_OFF_MESSAGE).toBe("Your teacher isn't accepting online submissions. Hand your paper to your teacher instead.");
  });
});

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

  it("saves a key whose model isn't available, with a warning naming the model, as not confirmed yet", async () => {
    expect(await saveApiKey(teacher, KEY, checker("model_unavailable"))).toEqual({
      warning: "Key saved. It works, but the model claude-opus-5-5 isn't available to it, so grading will pause until it is.",
    });
    // Settings keeps saying so after a reload, until a call with the key succeeds.
    expect(getAppSettings().apiKeyCheck).toBe("unverified");
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

  it("starts setting up the hosted agent for the new key, after switching grading over to it", async () => {
    vi.stubEnv("AI_MODE", "claude");
    resetConfigForTests();
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
    expect(getGrader()?.engine).toBe("agent");
    const resume = registerWorker();

    setGradingEngine("direct");

    expect(getAppSettings().gradingEngine).toBe("direct");
    expect(getGrader()?.engine).toBe("direct");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(hostedAgentSetup).not.toHaveBeenCalled();

    setGradingEngine("agent");

    expect(getAppSettings().gradingEngine).toBe("agent");
    expect(getGrader()?.engine).toBe("agent");
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
