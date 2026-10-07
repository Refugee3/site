import { describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "@/lib/config";
import { clearStoredApiKey, setStoredApiKey } from "@/lib/db/repos/settings";
import { encryptSecret } from "@/lib/secrets";
import { seedTeacher, useTestDb } from "@/test/helpers";
import { createFakeGrader } from "./fake";
import { checkApiKey, getGrader, resetGrader, setGraderForTests } from "./index";

// The test setup runs with AI_MODE=fake and an empty ANTHROPIC_API_KEY, and deletes the slot after each test.
// Claude-mode graders are built (constructing an SDK client sends nothing) but never called.

function useEnv(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  resetConfigForTests();
}

describe("getGrader", () => {
  it("returns the fake grader in fake mode and memoizes it", () => {
    const grader = getGrader();
    expect(grader?.mode).toBe("fake");
    expect(getGrader()).toBe(grader);
  });

  it("returns null in claude mode without an API key", () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    expect(getGrader()).toBeNull();
  });

  it("builds a claude grader from a key saved in the app or from ANTHROPIC_API_KEY", () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    setStoredApiKey({ ciphertext: encryptSecret("sk-ant-api03-saved-key-0000000000", "anthropic-api-key"), masked: "sk-ant-…0000",
      check: "verified", setBy: seedTeacher().id });
    expect(getGrader()?.mode).toBe("claude");

    resetGrader();
    clearStoredApiKey();
    expect(getGrader()).toBeNull();

    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "sk-ant-env-key-0000000000000000" });
    resetGrader();
    expect(getGrader()?.mode).toBe("claude");
  });

  it("lives in the process-wide slot, so deleting the slot resets it", () => {
    const grader = getGrader();
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pag.grader")];
    expect(getGrader()).not.toBe(grader);
  });
});

describe("setGraderForTests", () => {
  it("forces a grader or null, and undefined goes back to the configured one", () => {
    const scripted = createFakeGrader({ delayMs: 0 });
    setGraderForTests(scripted);
    expect(getGrader()).toBe(scripted);

    setGraderForTests(null);
    expect(getGrader()).toBeNull();

    setGraderForTests(undefined);
    const configured = getGrader();
    expect(configured).not.toBeNull();
    expect(configured).not.toBe(scripted);
  });
});

describe("resetGrader", () => {
  it("drops the memoized grader, so the next call builds it again", () => {
    const grader = getGrader();
    expect(getGrader()).toBe(grader);
    resetGrader();
    const rebuilt = getGrader();
    expect(rebuilt?.mode).toBe("fake");
    expect(rebuilt).not.toBe(grader);
  });

  it("also drops a grader forced by a test", () => {
    const scripted = createFakeGrader({ delayMs: 0 });
    setGraderForTests(scripted);
    resetGrader();
    expect(getGrader()).not.toBe(scripted);
    setGraderForTests(null);
    resetGrader();
    expect(getGrader()).not.toBeNull();
  });

  it("picks up a key saved after the grader was first built", () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    expect(getGrader()).toBeNull();
    setStoredApiKey({ ciphertext: encryptSecret("sk-ant-api03-saved-key-0000000000", "anthropic-api-key"), masked: "sk-ant-…0000",
      check: "unverified", setBy: seedTeacher().id });
    expect(getGrader()).toBeNull(); // memoized until reset
    resetGrader();
    expect(getGrader()?.mode).toBe("claude");
  });
});

describe("checkApiKey", () => {
  it("reports an unreachable Anthropic when the network fails", async () => {
    // The test setup makes every fetch throw, so the check fails to connect (after its one retry).
    expect(await checkApiKey("sk-ant-api03-candidate-0000000000")).toBe("unreachable");
  });
});
