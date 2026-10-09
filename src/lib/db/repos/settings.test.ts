import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClockForTests } from "@/lib/clock";
import type { DB } from "@/lib/db/connection";
import {
  clearStoredApiKey, getAiModel, getAppSettings, getGradingEngine, getHostedAgentState, markStoredApiKeyVerified, saveHostedAgentError,
  saveHostedAgentReady, setAiModel, setGradingEngine, setStoredApiKey, setStudentsCanUpload,
} from "@/lib/db/repos/settings";
import { seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
const STORED = { ciphertext: "v1.iv.tag.ct", masked: "sk-ant-…a1b2", check: "verified" as const };

let db: DB;

beforeEach(() => {
  setClockForTests(() => T0);
  db = useTestDb();
});

describe("app settings", () => {
  it("start with student uploads off and no saved key", () => {
    expect(getAppSettings()).toEqual({
      studentsCanUpload: false, apiKeyCiphertext: null, apiKeyMasked: null, apiKeyCheck: null, apiKeySetBy: null,
      apiKeySetAt: null, updatedAt: 0, gradingEngine: null, aiModel: "claude-sonnet-5-5",
    });
  });

  it("turn student uploads on and off", () => {
    setStudentsCanUpload(true);
    expect(getAppSettings()).toMatchObject({ studentsCanUpload: true, updatedAt: T0 });
    setStudentsCanUpload(false);
    expect(getAppSettings().studentsCanUpload).toBe(false);
  });

  it("store, replace and clear the API key, leaving the upload switch alone", () => {
    const teacher = seedTeacher();
    const other = seedTeacher();
    setStudentsCanUpload(true);

    setStoredApiKey({ ...STORED, setBy: teacher.id });
    expect(getAppSettings()).toEqual({
      studentsCanUpload: true, apiKeyCiphertext: STORED.ciphertext, apiKeyMasked: STORED.masked, apiKeyCheck: "verified",
      apiKeySetBy: teacher.id, apiKeySetAt: T0, updatedAt: T0, gradingEngine: null, aiModel: "claude-sonnet-5-5",
    });

    setClockForTests(() => T0 + 5);
    setStoredApiKey({ ciphertext: "v1.x.y.z", masked: "sk-ant-…zzzz", check: "unverified", setBy: other.id });
    expect(getAppSettings()).toMatchObject({
      apiKeyCiphertext: "v1.x.y.z", apiKeyMasked: "sk-ant-…zzzz", apiKeyCheck: "unverified", apiKeySetBy: other.id, apiKeySetAt: T0 + 5,
    });

    setClockForTests(() => T0 + 9);
    clearStoredApiKey();
    expect(getAppSettings()).toEqual({
      studentsCanUpload: true, apiKeyCiphertext: null, apiKeyMasked: null, apiKeyCheck: null, apiKeySetBy: null,
      apiKeySetAt: null, updatedAt: T0 + 9, gradingEngine: null, aiModel: "claude-sonnet-5-5",
    });
  });

  it("confirm an unverified key only while it is still the saved one", () => {
    const teacher = seedTeacher();
    expect(markStoredApiKeyVerified(STORED.ciphertext)).toBe(false);

    setStoredApiKey({ ...STORED, check: "unverified", setBy: teacher.id });
    setClockForTests(() => T0 + 5);
    // A call still running with an older key doesn't vouch for this one.
    expect(markStoredApiKeyVerified("v1.older.key.ct")).toBe(false);
    expect(getAppSettings()).toMatchObject({ apiKeyCheck: "unverified", updatedAt: T0 });

    expect(markStoredApiKeyVerified(STORED.ciphertext)).toBe(true);
    expect(getAppSettings()).toMatchObject({ apiKeyCiphertext: STORED.ciphertext, apiKeyCheck: "verified", apiKeySetAt: T0, updatedAt: T0 + 5 });
    expect(markStoredApiKeyVerified(STORED.ciphertext)).toBe(false);
  });

  it("keep the saved key when the teacher who saved it is deleted", () => {
    const teacher = seedTeacher();
    setStoredApiKey({ ...STORED, setBy: teacher.id });

    db.prepare("DELETE FROM teachers WHERE id = ?").run(teacher.id);

    expect(getAppSettings()).toMatchObject({ apiKeyCiphertext: STORED.ciphertext, apiKeySetBy: null });
  });

  it("refuse a key saved by an unknown teacher", () => {
    expect(() => setStoredApiKey({ ...STORED, setBy: "missing" })).toThrow(/FOREIGN KEY/);
    expect(getAppSettings().apiKeyCiphertext).toBeNull();
  });
});

describe("grading engine", () => {
  it("is the direct API until a teacher chooses, then follows the choice", () => {
    expect(getAppSettings().gradingEngine).toBeNull();
    expect(getGradingEngine()).toBe("direct");

    setClockForTests(() => T0 + 5);
    setGradingEngine("direct");
    expect(getGradingEngine()).toBe("direct");
    expect(getAppSettings()).toMatchObject({ gradingEngine: "direct", updatedAt: T0 + 5 });

    setGradingEngine("agent");
    expect(getGradingEngine()).toBe("agent");
    expect(getAppSettings().gradingEngine).toBe("agent");
  });

  it("is kept when the key or the upload switch changes", () => {
    setGradingEngine("direct");
    setStoredApiKey({ ...STORED, setBy: seedTeacher().id });
    clearStoredApiKey();
    setStudentsCanUpload(true);
    expect(getGradingEngine()).toBe("direct");
  });
});

describe("AI model", () => {
  it("is Sonnet 5.5 until a teacher chooses, then follows the choice", () => {
    expect(getAiModel()).toBe("claude-sonnet-5-5");

    setClockForTests(() => T0 + 5);
    setAiModel("claude-opus-5-5");
    expect(getAiModel()).toBe("claude-opus-5-5");
    expect(getAppSettings()).toMatchObject({ aiModel: "claude-opus-5-5", updatedAt: T0 + 5 });

    setAiModel("claude-sonnet-5-5");
    expect(getAiModel()).toBe("claude-sonnet-5-5");
  });

  it("is kept when the engine, the key or the upload switch changes, and changes none of them", () => {
    setGradingEngine("agent");
    setAiModel("claude-opus-5-5");
    expect(getGradingEngine()).toBe("agent");
    setGradingEngine("direct");
    setStoredApiKey({ ...STORED, setBy: seedTeacher().id });
    clearStoredApiKey();
    setStudentsCanUpload(true);
    expect(getAiModel()).toBe("claude-opus-5-5");
    expect(getAppSettings()).toMatchObject({ gradingEngine: "direct", studentsCanUpload: true, apiKeyCiphertext: null });
  });

  it("refuses a model that isn't offered", () => {
    expect(() => setAiModel("claude-opus-5" as never)).toThrow(/constraint/i);
    expect(getAiModel()).toBe("claude-sonnet-5-5");
  });
});

describe("hosted agent state", () => {
  const FP = "a".repeat(32);
  const ENVIRONMENT = { id: "env_1", hash: "env-hash" };
  const AGENTS = {
    extract: { id: "agent_x", version: 1, hash: "hx" },
    grade: { id: "agent_g", version: 3, hash: "hg" },
    scan: { id: "agent_s", version: 2, hash: "hs" },
  };

  function installId(): string {
    return (db.prepare("SELECT agent_install_id FROM app_settings").get() as { agent_install_id: string }).agent_install_id;
  }

  it("starts with an install id and nothing set up", () => {
    expect(getHostedAgentState()).toEqual({
      installId: expect.stringMatching(/^[0-9a-f]{12}$/), keyFp: null, environment: null, agents: {}, status: "none", error: null,
      checkedAt: null,
    });
    expect(getHostedAgentState().installId).toBe(installId());
  });

  it("saves a completed setup and reads it back", () => {
    const id = installId();
    setClockForTests(() => T0 + 7);

    saveHostedAgentReady({ keyFp: FP, environment: ENVIRONMENT, agents: AGENTS });

    expect(getHostedAgentState()).toEqual({
      installId: id, keyFp: FP, environment: ENVIRONMENT, agents: AGENTS, status: "ready", error: null, checkedAt: T0 + 7,
    });
    expect(getAppSettings().updatedAt).toBe(T0 + 7);
  });

  it("records an error without progress, keeping the stored ids", () => {
    saveHostedAgentReady({ keyFp: FP, environment: ENVIRONMENT, agents: AGENTS });
    setClockForTests(() => T0 + 9);

    saveHostedAgentError("  Anthropic rejected the API key. Replace it above.\n");

    expect(getHostedAgentState()).toMatchObject({
      keyFp: FP, environment: ENVIRONMENT, agents: AGENTS, status: "error", error: "Anthropic rejected the API key. Replace it above.",
      checkedAt: T0 + 9,
    });
  });

  it("records an error with progress, replacing the key fingerprint, environment and agents", () => {
    saveHostedAgentReady({ keyFp: FP, environment: ENVIRONMENT, agents: AGENTS });
    const otherFp = "b".repeat(32);

    saveHostedAgentError("Setup failed.", { keyFp: otherFp, environment: { id: "env_2", hash: "h2" }, agents: { extract: AGENTS.extract } });
    expect(getHostedAgentState()).toMatchObject({
      keyFp: otherFp, environment: { id: "env_2", hash: "h2" }, agents: { extract: AGENTS.extract }, status: "error", error: "Setup failed.",
    });

    saveHostedAgentError("Setup failed again.", { keyFp: otherFp, environment: null, agents: {} });
    expect(getHostedAgentState()).toMatchObject({ keyFp: otherFp, environment: null, agents: {}, error: "Setup failed again." });

    setClockForTests(() => T0 + 11);
    saveHostedAgentReady({ keyFp: FP, environment: ENVIRONMENT, agents: AGENTS });
    expect(getHostedAgentState()).toMatchObject({ status: "ready", error: null, checkedAt: T0 + 11, agents: AGENTS });
  });

  it("cuts a long error message to 500 characters, without splitting a character", () => {
    saveHostedAgentError(`  ${"x".repeat(600)}  `);
    expect(getHostedAgentState().error).toBe("x".repeat(500));

    saveHostedAgentError(`${"y".repeat(499)}😀😀`);
    expect(getHostedAgentState().error).toBe(`${"y".repeat(499)}😀`);
  });

  it.each([
    ["not JSON", "{", "{"],
    ["a wrong shape", JSON.stringify({ id: 1 }), JSON.stringify({ grade: { id: "agent_g", version: 0, hash: "h" } })],
    ["a non-object", "null", JSON.stringify(["agent_g"])],
  ])("reads %s in the JSON columns as nothing stored, with a warning", (_name, environmentJson, agentsJson) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.prepare("UPDATE app_settings SET agent_environment_json = ?, agent_agents_json = ?").run(environmentJson, agentsJson);

    expect(getHostedAgentState()).toMatchObject({ environment: null, agents: {} });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[settings] app_settings.agent_environment_json is unreadable; treating it as empty",
      "[settings] app_settings.agent_agents_json is unreadable; treating it as empty",
    ]);
    warn.mockRestore();
  });

  it("reads only the roles it knows, and only the fields it stores", () => {
    db.prepare("UPDATE app_settings SET agent_environment_json = ?, agent_agents_json = ?").run(
      JSON.stringify({ ...ENVIRONMENT, extra: true }),
      JSON.stringify({ grade: { ...AGENTS.grade, note: "x" }, review: AGENTS.extract }),
    );
    expect(getHostedAgentState()).toMatchObject({ environment: ENVIRONMENT, agents: { grade: AGENTS.grade } });
    expect(Object.keys(getHostedAgentState().agents)).toEqual(["grade"]);
  });

  it("generates and stores an install id when the row has none", () => {
    db.prepare("UPDATE app_settings SET agent_install_id = NULL").run();

    const id = getHostedAgentState().installId;

    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(installId()).toBe(id);
    expect(getHostedAgentState().installId).toBe(id);
  });
});
