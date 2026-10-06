import { describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "@/lib/config";
import { createFakeGrader } from "./fake";
import { getGrader, setGraderForTests } from "./index";

// The test setup runs with AI_MODE=fake and an empty ANTHROPIC_API_KEY, and deletes the slot after each test.
// A claude-mode grader with a key is not built here: that would construct a real Anthropic client.

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
    expect(getGrader()).toBeNull();
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
