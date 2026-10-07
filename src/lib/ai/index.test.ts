import { describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "@/lib/config";
import {
  clearStoredApiKey, getAppSettings, getHostedAgentState, setAiModel, setGradingEngine, setStoredApiKey,
} from "@/lib/db/repos/settings";
import { encryptSecret } from "@/lib/secrets";
import { seedTeacher, useTestDb } from "@/test/helpers";
import { apiKeyFingerprint } from "./api-key";
import type { MessageRunner } from "./claude";
import { createFakeGrader } from "./fake";
import {
  checkApiKey, confirmKeyOnSuccess, currentGraderEngine, getGrader, getHostedAgentStatus, HOSTED_AGENT_NOT_CHOSEN, resetGrader,
  setGraderForTests, setUpHostedAgentNow, startHostedAgentSetup,
} from "./index";
import { makeKeyItem, makeMessage } from "./test-utils";

// The test setup runs with AI_MODE=fake and an empty ANTHROPIC_API_KEY, and deletes the slot after each test.
// Claude-mode graders are built (constructing an SDK client sends nothing) but never called.

function useEnv(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  resetConfigForTests();
}

const KEY_A = "sk-ant-api03-saved-key-aaaaaaaaaa";
const KEY_B = "sk-ant-api03-saved-key-bbbbbbbbbb";

function saveKey(key: string) {
  setStoredApiKey({ ciphertext: encryptSecret(key, "anthropic-api-key"), masked: `sk-ant-…${key.slice(-4)}`, check: "unverified",
    setBy: seedTeacher().id });
}

/**
 * Anthropic's Managed Agents endpoints, in place of the network: every create succeeds, and each request waits until
 * `release()` (all requests are recorded with their headers).
 */
function fakeManagedAgentsApi() {
  const requests: Array<{ method: string; path: string; headers: Headers }> = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({ method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers) });
    await released;
    const id = `${url.pathname.split("/").at(-1)}_${requests.length}`;
    const created = url.pathname === "/v1/environments" ? { id, name: "pdf-autograder", archived_at: null } : { id, version: 1, archived_at: null };
    return Response.json(created);
  });
  return { requests, release, restore: () => fetchSpy.mockRestore() };
}

/**
 * Anthropic's API in place of the network, answering at once: Managed Agents creates and updates (each update of an
 * agent bumps its version, keeping its id), and every Messages or Models request is refused with a 400 after it is
 * recorded. Records each request's method, path and JSON body.
 */
function fakeAnthropicApi() {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const versions = new Map<string, number>();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    requests.push({ method, path: url.pathname, body });
    if (url.pathname === "/v1/environments") return Response.json({ id: "env_1", name: "pdf-autograder", archived_at: null });
    if (url.pathname === "/v1/agents") {
      const id = `agent_${versions.size + 1}`;
      versions.set(id, 1);
      return Response.json({ id, version: 1, archived_at: null });
    }
    const agent = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (agent && method === "POST") {
      const version = (versions.get(agent[1]) ?? 0) + 1;
      versions.set(agent[1], version);
      return Response.json({ id: agent[1], version, archived_at: null });
    }
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "test" } }, { status: 400 });
  });
  return { requests, restore: () => fetchSpy.mockRestore() };
}

const gradeInput = {
  assignment: { title: "Quiz", instructions: "" }, teacherNotes: "", sections: [], items: [makeKeyItem()], keyPdf: null,
  studentPdf: new Uint8Array([37, 80, 68, 70]), studentPageCount: 1,
};
const scanInput = {
  assignmentTitle: "Quiz", sections: [], items: [makeKeyItem()], keyPageCount: null, chunkPdf: new Uint8Array([37, 80, 68, 70]),
  firstPage: 1, chunkPageCount: 1, totalPages: 1, previousPage: null,
};

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

describe("the grading engine", () => {
  it("is the direct API by default in claude mode, and the hosted agent once chosen", () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    saveKey(KEY_A);
    expect(getAppSettings().gradingEngine).toBeNull();
    expect(getGrader()).toMatchObject({ mode: "claude", engine: "direct" });
    expect(currentGraderEngine()).toBe("direct");

    setGradingEngine("agent");
    expect(getGrader()?.engine).toBe("direct"); // memoized until reset
    resetGrader();
    expect(getGrader()).toMatchObject({ mode: "claude", engine: "agent" });
    expect(currentGraderEngine()).toBe("agent");

    clearStoredApiKey();
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "sk-ant-env-key-0000000000000000" });
    resetGrader();
    expect(getGrader()).toMatchObject({ mode: "claude", engine: "agent" });

    setGradingEngine("direct");
    resetGrader();
    expect(getGrader()).toMatchObject({ mode: "claude", engine: "direct" });
  });

  it("is the practice grader in fake mode, whatever was chosen, and none without a key", () => {
    useTestDb();
    setGradingEngine("direct");
    expect(getGrader()).toMatchObject({ mode: "fake", engine: "fake" });
    expect(currentGraderEngine()).toBe("fake");

    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    resetGrader();
    expect(getGrader()).toBeNull();
    expect(currentGraderEngine()).toBeNull();
  });

  it("is told without building a grader", () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    saveKey(KEY_A);
    expect(currentGraderEngine()).toBe("direct");
    setGradingEngine("agent");
    expect(currentGraderEngine()).toBe("agent");
    expect((globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pag.grader")]).toBeUndefined();
  });
});

describe("the AI model", () => {
  it("is what the direct engine sends answer keys and papers to; scans always go to Sonnet 5.5", async () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    saveKey(KEY_A);
    const api = fakeAnthropicApi();
    try {
      const models = async () => {
        api.requests.length = 0;
        resetGrader();
        const grader = getGrader()!;
        expect(grader.engine).toBe("direct");
        await expect(grader.extractKey({ assignmentTitle: "Q", teacherNotes: "", keyPdf: gradeInput.studentPdf, pageCount: 1 }))
          .rejects.toMatchObject({ code: "bad_request" });
        await expect(grader.gradeSubmission(gradeInput)).rejects.toMatchObject({ code: "bad_request" });
        await expect(grader.readScanPages(scanInput)).rejects.toMatchObject({ code: "bad_request" });
        return api.requests.map((r) => [r.path, r.body?.model]);
      };

      // Sonnet 5.5 by default.
      expect(await models()).toEqual([
        ["/v1/messages", "claude-sonnet-5-5"], ["/v1/messages", "claude-sonnet-5-5"], ["/v1/messages", "claude-sonnet-5-5"],
      ]);
      setAiModel("claude-opus-5-5");
      expect(await models()).toEqual([
        ["/v1/messages", "claude-opus-5-5"], ["/v1/messages", "claude-opus-5-5"], ["/v1/messages", "claude-sonnet-5-5"],
      ]);
    } finally {
      api.restore();
    }
  });

  it("is what a key is checked against", async () => {
    useTestDb();
    const api = fakeAnthropicApi();
    try {
      await checkApiKey("sk-ant-api03-candidate-0000000000");
      setAiModel("claude-opus-5-5");
      await checkApiKey("sk-ant-api03-candidate-0000000000");
      expect(api.requests.map((r) => r.path)).toEqual(["/v1/models/claude-sonnet-5-5", "/v1/models/claude-opus-5-5"]);
    } finally {
      api.restore();
    }
  });

  it("is what the hosted agent's key reader and grader run on: a change updates them, and the scan splitter stays on Sonnet", async () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    saveKey(KEY_A);
    setGradingEngine("agent");
    const api = fakeAnthropicApi();
    try {
      expect(await setUpHostedAgentNow()).toEqual({ ok: true });
      expect(api.requests.filter((r) => r.path === "/v1/agents").map((r) => r.body?.model)).toEqual([
        { id: "claude-sonnet-5-5", effort: "high" }, { id: "claude-sonnet-5-5", effort: "high" }, { id: "claude-sonnet-5-5", effort: "medium" },
      ]);
      const ids = getHostedAgentState().agents;

      api.requests.length = 0;
      setAiModel("claude-opus-5-5");
      expect(getHostedAgentStatus()?.state).toBe("not_set_up");
      startHostedAgentSetup();
      await vi.waitFor(() => expect(getHostedAgentStatus()?.state).toBe("ready"));

      // The same two agents, updated to a new version; nothing created, the scan splitter untouched.
      expect(api.requests.map((r) => [r.method, r.path, r.body?.model])).toEqual([
        ["POST", `/v1/agents/${ids.extract!.id}`, { id: "claude-opus-5-5", effort: "high" }],
        ["POST", `/v1/agents/${ids.grade!.id}`, { id: "claude-opus-5-5", effort: "high" }],
      ]);
      expect(getHostedAgentState().agents).toMatchObject({
        extract: { id: ids.extract!.id, version: 2 }, grade: { id: ids.grade!.id, version: 2 }, scan: ids.scan,
      });
    } finally {
      api.restore();
    }
  });
});

describe("setting up the hosted agent", () => {
  it("does nothing in fake mode, without a key or with the direct API chosen", async () => {
    const api = fakeManagedAgentsApi();
    try {
      useTestDb();
      saveKey(KEY_A);
      startHostedAgentSetup();
      expect(getHostedAgentStatus()).toBeNull();
      expect(await setUpHostedAgentNow()).toEqual({ ok: false, error: "Practice mode (AI_MODE=fake) doesn't use the hosted agent." });

      useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
      clearStoredApiKey();
      startHostedAgentSetup();
      expect(getHostedAgentStatus()).toBeNull();
      expect(await setUpHostedAgentNow()).toEqual({ ok: false, error: "Add an API key first." });

      // Never chosen: the direct API, so nothing is created in the key's workspace.
      saveKey(KEY_A);
      startHostedAgentSetup();
      expect(await setUpHostedAgentNow()).toEqual({ ok: false, error: HOSTED_AGENT_NOT_CHOSEN });
      expect(HOSTED_AGENT_NOT_CHOSEN).toBe("Choose the Anthropic-hosted agent under Grader first.");

      setGradingEngine("direct");
      startHostedAgentSetup();
      expect(await setUpHostedAgentNow()).toEqual({ ok: false, error: HOSTED_AGENT_NOT_CHOSEN });
      // Settings still shows the hosted agent's state for the key, which is used again once it is chosen.
      expect(getHostedAgentStatus()).toEqual({ state: "not_set_up", error: null, checkedAt: null });
      expect(api.requests).toEqual([]);
    } finally {
      api.restore();
    }
  });

  it("sets up with the key in use, sent as the API key only, and saves the result for that key", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-token");
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "sk-ant-env-key-0000000000000000" });
    useTestDb();
    saveKey(KEY_A);
    setGradingEngine("agent");
    const api = fakeManagedAgentsApi();
    try {
      const done = setUpHostedAgentNow();
      await vi.waitFor(() => expect(api.requests).toHaveLength(1));
      expect(getHostedAgentStatus()).toEqual({ state: "setting_up", error: null, checkedAt: null });
      api.release();

      expect(await done).toEqual({ ok: true });
      expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /v1/environments", "POST /v1/agents", "POST /v1/agents", "POST /v1/agents",
      ]);
      expect(api.requests.every((r) => r.headers.get("x-api-key") === KEY_A && r.headers.get("authorization") === null)).toBe(true);
      expect(getHostedAgentStatus()).toMatchObject({ state: "ready", error: null });
      const state = getHostedAgentState();
      expect(state).toMatchObject({ status: "ready", keyFp: apiKeyFingerprint(KEY_A), environment: { id: "environments_1" } });
      expect(JSON.stringify(state)).not.toContain(KEY_A);
    } finally {
      api.restore();
    }
  });

  it("uses the server's ANTHROPIC_API_KEY when no key is saved", async () => {
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "sk-ant-env-key-0000000000000000" });
    useTestDb();
    setGradingEngine("agent");
    const api = fakeManagedAgentsApi();
    try {
      api.release();
      expect(await setUpHostedAgentNow()).toEqual({ ok: true });
      expect(api.requests[0].headers.get("x-api-key")).toBe("sk-ant-env-key-0000000000000000");
      expect(getHostedAgentState().keyFp).toBe(apiKeyFingerprint("sk-ant-env-key-0000000000000000"));
    } finally {
      api.restore();
    }
  });

  it("doesn't save a setup result for a key that was replaced meanwhile, leaving the new key's state as it was", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    useEnv({ AI_MODE: "claude", ANTHROPIC_API_KEY: "" });
    useTestDb();
    saveKey(KEY_A);
    setGradingEngine("agent");
    const api = fakeManagedAgentsApi();
    try {
      startHostedAgentSetup();
      await vi.waitFor(() => expect(api.requests).toHaveLength(1));
      expect(api.requests[0].headers.get("x-api-key")).toBe(KEY_A);

      // The teacher saves another key while the setup for the first one is still running.
      saveKey(KEY_B);
      const before = getHostedAgentState();
      api.release();

      await vi.waitFor(() => expect(info).toHaveBeenCalledWith("[agent] setup result for a replaced API key not saved"));
      expect(api.requests).toHaveLength(4);
      expect(getHostedAgentState()).toEqual(before);
      expect(before).toMatchObject({ status: "none", keyFp: null, environment: null, agents: {} });
      expect(getHostedAgentStatus()).toEqual({ state: "not_set_up", error: null, checkedAt: null });
    } finally {
      api.restore();
    }
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

describe("confirmKeyOnSuccess", () => {
  it("confirms the saved key after its first successful call, not after a failed one", async () => {
    useTestDb();
    const ciphertext = encryptSecret("sk-ant-api03-saved-key-0000000000", "anthropic-api-key");
    setStoredApiKey({ ciphertext, masked: "sk-ant-…0000", check: "unverified", setBy: seedTeacher().id });
    const answers = [new Error("overloaded"), makeMessage({ text: "{}" }), makeMessage({ text: "{}" })];
    const calls: unknown[] = [];
    const scripted: MessageRunner = async (params) => {
      calls.push(params);
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    };
    const runner = confirmKeyOnSuccess(scripted, ciphertext);
    const params = {} as Parameters<MessageRunner>[0];

    await expect(runner(params, {})).rejects.toThrow("overloaded");
    expect(getAppSettings().apiKeyCheck).toBe("unverified");

    expect(await runner(params, {})).toMatchObject({ id: "msg_test" });
    expect(getAppSettings().apiKeyCheck).toBe("verified");

    // Once per grader: a key saved again as unverified (the grader is rebuilt then) is not confirmed by this one.
    setStoredApiKey({ ciphertext, masked: "sk-ant-…0000", check: "unverified", setBy: seedTeacher().id });
    await runner(params, {});
    expect(getAppSettings().apiKeyCheck).toBe("unverified");
    expect(calls).toHaveLength(3);
  });
});

describe("checkApiKey", () => {
  it("reports an unreachable Anthropic when the network fails", async () => {
    // The test setup makes every fetch throw, so the check fails to connect (after its one retry).
    expect(await checkApiKey("sk-ant-api03-candidate-0000000000")).toBe("unreachable");
  });
});
