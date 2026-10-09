import { describe, expect, it, vi } from "vitest";
import { AiError } from "../errors";
import { AGENT_ROLES, agentDefinition, type AgentEngineConfig, environmentDefinition } from "./definitions";
import {
  agentProcessSlot,
  ensureProvisioned,
  hostedAgentStatus,
  type ProvisionDeps,
  setUpHostedAgentNow,
  startHostedAgentSetup,
} from "./provision";
import { apiError, createFakeManagedAgents, type FakeManagedAgents, memoryStore, type MemoryStore, testAgentConfig } from "./test-fake";

const FP = "0123456789abcdef0123456789abcdef";
const FP2 = "fedcba9876543210fedcba9876543210";
const INSTALL = "a1b2c3d4e5f6";
const NOT_ALLOWED = "This API key isn't allowed to use Claude Managed Agents. In the Anthropic Console, check that Managed Agents is "
  + "available to your organization and workspace, or switch to Direct API.";

function setup(o: { fake?: FakeManagedAgents; store?: MemoryStore; cfg?: AgentEngineConfig } = {}) {
  const fake = o.fake ?? createFakeManagedAgents();
  const store = o.store ?? memoryStore({ installId: INSTALL });
  const key = { fp: FP };
  const d: ProvisionDeps = { port: fake.port, store, cfg: o.cfg ?? testAgentConfig(), keyFingerprint: () => key.fp };
  return { fake, store, key, d };
}

/** A setup that already ran once; the calls it made are forgotten. */
async function provisioned(o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  await ensureProvisioned(s.d);
  s.fake.calls.length = 0;
  s.store.saves.length = 0;
  return s;
}

const count = (fake: FakeManagedAgents, method: string) => fake.calls.filter((c) => c.method === method).length;

async function rejection(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AiError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

describe("ensureProvisioned", () => {
  it("creates one environment and three agents, saves them as ready and returns their ids", async () => {
    const { fake, store, d } = setup();
    const result = await ensureProvisioned(d);

    expect(fake.methods()).toEqual(["createEnvironment", "createAgent", "createAgent", "createAgent"]);
    const env = environmentDefinition(INSTALL);
    expect(fake.calls[0].args[0]).toEqual(env.params);
    AGENT_ROLES.forEach((role, i) => expect(fake.calls[i + 1].args[0]).toEqual(agentDefinition(role, d.cfg, INSTALL).params));
    expect(result).toEqual({
      installId: INSTALL,
      environmentId: "env_1",
      agents: { extract: { id: "agent_1", version: 1 }, grade: { id: "agent_2", version: 1 }, scan: { id: "agent_3", version: 1 } },
    });
    expect(store.state).toMatchObject({
      status: "ready", error: null, keyFp: FP,
      environment: { id: "env_1", hash: env.hash },
      agents: {
        extract: { id: "agent_1", version: 1, hash: agentDefinition("extract", d.cfg, INSTALL).hash },
        grade: { id: "agent_2", version: 1, hash: agentDefinition("grade", d.cfg, INSTALL).hash },
        scan: { id: "agent_3", version: 1, hash: agentDefinition("scan", d.cfg, INSTALL).hash },
      },
    });
    expect(store.state.checkedAt).toEqual(expect.any(Number));
  });

  it("gives setup calls only a timeout, never a caller's signal", async () => {
    const { fake, d } = setup();
    await ensureProvisioned(d, { signal: new AbortController().signal });
    for (const c of fake.calls) expect(c.args.at(-1)).toEqual({ timeoutMs: 30_000 });
  });

  it("returns the stored ids without any network call when they are current", async () => {
    const { fake, store, d } = await provisioned();
    const result = await ensureProvisioned(d);
    expect(fake.calls).toEqual([]);
    expect(store.saves).toEqual([]);
    expect(result.agents.grade).toEqual({ id: "agent_2", version: 1 });
  });

  it("sets up once for concurrent callers", async () => {
    const { fake, d } = setup();
    const results = await Promise.all([ensureProvisioned(d), ensureProvisioned(d), ensureProvisioned(d)]);
    expect(count(fake, "createEnvironment")).toBe(1);
    expect(count(fake, "createAgent")).toBe(3);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(agentProcessSlot().flights.size).toBe(0);
  });

  it("rejects only the caller whose signal aborts; the flight completes for the others and is saved", async () => {
    const { fake, store, d } = setup();
    const held = fake.hold("createEnvironment");
    const job = new AbortController();
    const aborted = ensureProvisioned(d, { signal: job.signal });
    const other = ensureProvisioned(d);
    job.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted", message: "The grading job was stopped." });
    held.release();
    await expect(other).resolves.toMatchObject({ environmentId: "env_1" });
    expect(store.state.status).toBe("ready");
    expect(count(fake, "createEnvironment")).toBe(1);
  });

  it("rejects at once when the caller's signal already aborted", async () => {
    const { d } = setup();
    const job = new AbortController();
    job.abort();
    expect((await rejection(ensureProvisioned(d, { signal: job.signal }))).code).toBe("aborted");
  });

  it("runs one forced setup after a normal one that was running; concurrent forced callers share it", async () => {
    const { fake, d } = setup();
    const held = fake.hold("createEnvironment");
    const normal = ensureProvisioned(d);
    const forcedA = ensureProvisioned(d, { force: true });
    const forcedB = ensureProvisioned(d, { force: true });
    held.release();
    const [n, a, b] = await Promise.all([normal, forcedA, forcedB]);
    expect(a).toEqual(n);
    expect(b).toEqual(n);
    // The forced setup reloaded what the first one saved: it checked those ids instead of creating new ones.
    expect(count(fake, "createEnvironment")).toBe(1);
    expect(count(fake, "createAgent")).toBe(3);
    expect(count(fake, "retrieveEnvironment")).toBe(1);
    expect(fake.calls.find((c) => c.method === "retrieveEnvironment")?.args[0]).toBe("env_1");
    expect(count(fake, "retrieveAgent")).toBe(3);
    expect(count(fake, "updateEnvironment")).toBe(1);
  });

  it("re-verifies after a stored error before declaring ready again", async () => {
    const { fake, store, d } = await provisioned();
    store.state = { ...store.state, status: "error", error: "Anthropic couldn't be reached just now (server_error)." };
    await ensureProvisioned(d);
    expect(fake.methods()).toEqual(["retrieveEnvironment", "retrieveAgent", "retrieveAgent", "retrieveAgent"]);
    expect(store.state).toMatchObject({ status: "ready", error: null, environment: { id: "env_1" } });
  });

  it("adopts the existing objects for a new key fingerprint when they all exist", async () => {
    const { fake, store, key, d } = await provisioned();
    key.fp = FP2;
    const result = await ensureProvisioned(d);
    expect(fake.methods()).toEqual(["retrieveEnvironment", "retrieveAgent", "retrieveAgent", "retrieveAgent"]);
    expect(store.state.keyFp).toBe(FP2);
    expect(result.environmentId).toBe("env_1");
  });

  it("drops ids that answer 403 during verification and creates anew", async () => {
    const fake = createFakeManagedAgents();
    const store = memoryStore({
      installId: INSTALL, keyFp: FP2, status: "ready",
      environment: { id: "env_elsewhere", hash: environmentDefinition(INSTALL).hash },
      agents: { extract: { id: "agent_elsewhere", version: 2, hash: "h" } },
    });
    const { d } = setup({ fake, store });
    fake.fail("retrieveEnvironment", apiError(403));
    fake.fail("retrieveAgent", apiError(403));
    await ensureProvisioned(d);
    expect(fake.methods()).toEqual(["retrieveEnvironment", "retrieveAgent", "createEnvironment", "createAgent", "createAgent", "createAgent"]);
    expect(store.state).toMatchObject({ status: "ready", keyFp: FP, environment: { id: "env_1" }, agents: { extract: { id: "agent_1" } } });
  });

  it("re-creates only what is gone or archived", async () => {
    const { fake, store, key, d } = await provisioned();
    fake.agents.get("agent_2")!.archived = true;
    fake.agents.delete("agent_3");
    key.fp = FP2;
    await ensureProvisioned(d);
    expect(count(fake, "createEnvironment")).toBe(0);
    expect(fake.calls.filter((c) => c.method === "createAgent").map((c) => (c.args[0] as { name: string }).name)).toEqual([
      "PDF Auto-Grader: paper grader [a1b2c3d4e5f6]", "PDF Auto-Grader: scan splitter [a1b2c3d4e5f6]",
    ]);
    expect(store.state.agents).toMatchObject({ extract: { id: "agent_1" }, grade: { id: "agent_4" }, scan: { id: "agent_5" } });
  });

  it("re-creates an environment that was archived", async () => {
    const { fake, store, key, d } = await provisioned();
    fake.environments.get("env_1")!.archived = true;
    fake.environments.get("env_1")!.name = "renamed-before-archiving";
    key.fp = FP2;
    await ensureProvisioned(d);
    expect(count(fake, "createEnvironment")).toBe(1);
    expect(store.state.environment?.id).toBe("env_2");
  });

  it("updates changed agent definitions at their stored version and leaves the environment alone", async () => {
    const { fake, store, d } = await provisioned();
    const cfg = testAgentConfig({ effort: "xhigh" });
    await ensureProvisioned({ ...d, cfg });
    expect(fake.methods()).toEqual(["updateAgent", "updateAgent"]);
    expect(fake.calls.map((c) => [c.args[0], (c.args[1] as { version: number }).version])).toEqual([["agent_1", 1], ["agent_2", 1]]);
    expect(fake.calls[0].args[1]).toEqual({ ...agentDefinition("extract", cfg, INSTALL).params, version: 1 });
    expect(store.state.agents).toMatchObject({
      extract: { version: 2, hash: agentDefinition("extract", cfg, INSTALL).hash },
      grade: { version: 2, hash: agentDefinition("grade", cfg, INSTALL).hash },
      scan: { version: 1 },
    });
  });

  it("moves the answer-key reader and the paper grader to a newly chosen model as new versions, creating nothing", async () => {
    const { fake, store, d } = await provisioned();
    const before = structuredClone(store.state.agents);
    const sonnet = testAgentConfig({ model: "claude-sonnet-5-5" });

    const result = await ensureProvisioned({ ...d, cfg: sonnet });

    expect(fake.methods()).toEqual(["updateAgent", "updateAgent"]);
    expect(fake.calls.map((c) => [c.args[0], (c.args[1] as { model: unknown }).model])).toEqual([
      ["agent_1", { id: "claude-sonnet-5-5", effort: "high" }],
      ["agent_2", { id: "claude-sonnet-5-5", effort: "high" }],
    ]);
    expect(store.state.agents).toEqual({
      extract: { id: before.extract!.id, version: 2, hash: agentDefinition("extract", sonnet, INSTALL).hash },
      grade: { id: before.grade!.id, version: 2, hash: agentDefinition("grade", sonnet, INSTALL).hash },
      scan: before.scan,
    });
    expect(result.agents).toEqual({ extract: { id: "agent_1", version: 2 }, grade: { id: "agent_2", version: 2 }, scan: { id: "agent_3", version: 1 } });

    // Switching back is another update of the same agents; a setup that is current makes no call at all.
    fake.calls.length = 0;
    await ensureProvisioned(d);
    expect(fake.methods()).toEqual(["updateAgent", "updateAgent"]);
    expect(store.state.agents).toMatchObject({ extract: { id: "agent_1", version: 3 }, grade: { id: "agent_2", version: 3 } });
    fake.calls.length = 0;
    await ensureProvisioned(d);
    expect(fake.calls).toEqual([]);
    expect(count(fake, "createAgent")).toBe(0);
  });

  it("never hands a caller a setup for other definitions (the model changed meanwhile): it waits, then applies its own", async () => {
    const { fake, store, d } = await provisioned();
    const sonnet = testAgentConfig({ model: "claude-sonnet-5-5" });
    const opusMax = testAgentConfig({ effort: "max" });
    const held = fake.hold("updateAgent");

    const first = ensureProvisioned({ ...d, cfg: sonnet });
    const second = ensureProvisioned({ ...d, cfg: opusMax });
    held.release();
    const [a, b] = await Promise.all([first, second]);

    expect(fake.calls.map((c) => [c.method, (c.args[1] as { model: unknown }).model])).toEqual([
      ["updateAgent", { id: "claude-sonnet-5-5", effort: "high" }], ["updateAgent", { id: "claude-sonnet-5-5", effort: "high" }],
      ["updateAgent", { id: "claude-opus-5-5", effort: "max" }], ["updateAgent", { id: "claude-opus-5-5", effort: "max" }],
    ]);
    // Each caller runs on the versions that carry its own definitions.
    expect([a.agents.grade, b.agents.grade]).toEqual([{ id: "agent_2", version: 2 }, { id: "agent_2", version: 3 }]);
    expect(store.state.agents.grade?.hash).toBe(agentDefinition("grade", opusMax, INSTALL).hash);
  });

  it("updates the environment when its definition hash changed", async () => {
    const { fake, store, d } = await provisioned();
    store.state = { ...store.state, environment: { id: "env_1", hash: "old" } };
    await ensureProvisioned(d);
    const { config, description, metadata } = environmentDefinition(INSTALL).params;
    expect(fake.calls).toEqual([{ method: "updateEnvironment", args: ["env_1", { config, description, metadata }, { timeoutMs: 30_000 }] }]);
    expect(store.state.environment).toEqual({ id: "env_1", hash: environmentDefinition(INSTALL).hash });
  });

  it("creates the environment again when its update finds it gone", async () => {
    const { fake, store, d } = await provisioned();
    fake.environments.delete("env_1");
    store.state = { ...store.state, environment: { id: "env_1", hash: "old" } };
    await ensureProvisioned(d);
    expect(fake.methods()).toEqual(["updateEnvironment", "createEnvironment"]);
    expect(store.state.environment?.id).toBe("env_2");
  });

  it("re-applies the definition to an agent edited in the Console", async () => {
    const { fake, store, key, d } = await provisioned();
    fake.agents.get("agent_1")!.version = 3;
    key.fp = FP2;
    await ensureProvisioned(d);
    const updates = fake.calls.filter((c) => c.method === "updateAgent");
    expect(updates.map((c) => [c.args[0], (c.args[1] as { version: number }).version])).toEqual([["agent_1", 3]]);
    expect(store.state.agents.extract).toMatchObject({ id: "agent_1", version: 4, hash: agentDefinition("extract", d.cfg, INSTALL).hash });
  });

  it("retries an agent update once with the version it re-reads after a 409", async () => {
    const { fake, store, d } = await provisioned();
    fake.agents.get("agent_2")!.version = 5; // edited meanwhile; the stored version is 1
    const cfg = testAgentConfig({ effort: "max" });
    await ensureProvisioned({ ...d, cfg });
    const grade = fake.calls.filter((c) => c.args[0] === "agent_2").map((c) => [c.method, (c.args[1] as { version?: number })?.version]);
    expect(grade).toEqual([["updateAgent", 1], ["retrieveAgent", undefined], ["updateAgent", 5]]);
    expect(store.state.agents.grade).toMatchObject({ version: 6 });
  });

  it("gives up on a second conflict and tries again later", async () => {
    const { fake, store, d } = await provisioned();
    fake.fail("updateAgent", apiError(409), { times: 2 });
    const err = await rejection(ensureProvisioned({ ...d, cfg: testAgentConfig({ effort: "max" }) }));
    expect(err.code).toBe("server_error");
    expect(err.o.retryable).toBe(true);
    expect(store.state).toMatchObject({
      status: "error", error: "Anthropic couldn't be reached just now (server_error). It's tried again before the next paper.",
    });
  });

  it("adopts the environment by name after a 409 on create", async () => {
    const { fake, store, d } = setup();
    await fake.port.createEnvironment({ name: `pdf-autograder-${INSTALL}` });
    fake.calls.length = 0;
    await ensureProvisioned(d);
    expect(fake.methods()).toEqual(["createEnvironment", "findEnvironmentByName", "updateEnvironment", "createAgent", "createAgent", "createAgent"]);
    expect(store.state.environment).toEqual({ id: "env_1", hash: environmentDefinition(INSTALL).hash });
  });

  it("explains a name held by an unusable environment and pauses", async () => {
    const { fake, store, d } = setup();
    await fake.port.createEnvironment({ name: `pdf-autograder-${INSTALL}` });
    fake.environments.get("env_1")!.archived = true;
    const err = await rejection(ensureProvisioned(d));
    const message = `An environment named "pdf-autograder-${INSTALL}" already exists in your Anthropic workspace but can't be used `
      + "(it may be archived). Delete it in the Anthropic Console, then press Set up again, or switch to Direct API.";
    expect(err).toMatchObject({ code: "agent_unavailable", message });
    expect(err.o.pauseWorker).toBe(true);
    expect(store.state).toMatchObject({ status: "error", error: message, environment: null });
  });

  it("maps a 403 to agent_unavailable and keeps the partial progress, so the next attempt creates no duplicates", async () => {
    const { fake, store, d } = setup();
    fake.fail("createAgent", apiError(403), { match: ([p]) => (p as { name: string }).name.includes("paper grader") });
    const err = await rejection(ensureProvisioned(d));
    expect(err).toMatchObject({ code: "agent_unavailable", message: NOT_ALLOWED });
    expect(store.saves).toEqual([{
      kind: "error", message: NOT_ALLOWED,
      progress: {
        keyFp: FP,
        environment: { id: "env_1", hash: environmentDefinition(INSTALL).hash },
        agents: { extract: expect.objectContaining({ id: "agent_1" }) },
      },
    }]);
    expect(store.state.status).toBe("error");

    fake.calls.length = 0;
    await ensureProvisioned(d);
    expect(fake.methods()).toEqual(["retrieveEnvironment", "retrieveAgent", "createAgent", "createAgent"]);
    expect(store.state).toMatchObject({ status: "ready", agents: { extract: { id: "agent_1" }, grade: { id: "agent_2" }, scan: { id: "agent_3" } } });
  });

  it("maps a 401 to auth", async () => {
    const { fake, store, d } = setup();
    fake.fail("createEnvironment", apiError(401));
    await expect(ensureProvisioned(d)).rejects.toMatchObject({ code: "auth", message: "Anthropic rejected the API key. Replace it above." });
    expect(store.state).toMatchObject({ status: "error", error: "Anthropic rejected the API key. Replace it above." });
  });

  it("records a rate limit as retryable, with the 'tried again' text", async () => {
    const { fake, store, d } = setup();
    fake.fail("createEnvironment", apiError(429));
    const err = await rejection(ensureProvisioned(d));
    expect(err.code).toBe("rate_limited");
    expect(err.o.retryable).toBe(true);
    expect(store.state).toMatchObject({
      status: "error", error: "Anthropic couldn't be reached just now (rate_limited). It's tried again before the next paper.",
    });
  });

  it("rejects with an AiError when the key can't be read", async () => {
    const { d } = setup();
    await expect(rejection(ensureProvisioned({ ...d, keyFingerprint: () => { throw new Error("no key"); } }))).resolves.toBeInstanceOf(AiError);
  });
});

describe("startHostedAgentSetup", () => {
  it("runs the setup in the background and never throws", async () => {
    const { fake, store, d } = setup();
    fake.fail("createEnvironment", apiError(401));
    expect(() => startHostedAgentSetup(d)).not.toThrow();
    await vi.waitFor(() => expect(store.state.status).toBe("error"));
  });
});

describe("setUpHostedAgentNow", () => {
  it("forces a re-check of every object and reports success", async () => {
    const { fake, d } = await provisioned();
    await expect(setUpHostedAgentNow(d)).resolves.toEqual({ ok: true });
    expect(fake.methods()).toEqual(["retrieveEnvironment", "retrieveAgent", "retrieveAgent", "retrieveAgent", "updateEnvironment"]);
  });

  it("returns the teacher's message on failure", async () => {
    const { fake, d } = setup();
    fake.fail("createEnvironment", apiError(403));
    await expect(setUpHostedAgentNow(d)).resolves.toEqual({ ok: false, error: NOT_ALLOWED });
  });

  it("stops waiting after its timeout and leaves the setup running", async () => {
    const { fake, store, d } = setup();
    const held = fake.hold("createEnvironment");
    await expect(setUpHostedAgentNow(d, 5)).resolves.toEqual({ ok: false, error: "Anthropic didn't answer in time. Try again in a minute." });
    expect(hostedAgentStatus(d).state).toBe("setting_up");
    held.release();
    await vi.waitFor(() => expect(store.state.status).toBe("ready"));
    expect(hostedAgentStatus(d).state).toBe("ready");
  });
});

describe("hostedAgentStatus", () => {
  it("is not_set_up before any setup", () => {
    const { fake, d } = setup();
    expect(hostedAgentStatus(d)).toEqual({ state: "not_set_up", error: null, checkedAt: null });
    expect(fake.calls).toEqual([]);
  });

  it("is setting_up while a setup for this key runs", async () => {
    const { fake, d } = setup();
    const held = fake.hold("createEnvironment");
    const flight = ensureProvisioned(d);
    expect(hostedAgentStatus(d)).toEqual({ state: "setting_up", error: null, checkedAt: null });
    held.release();
    await flight;
  });

  it("is ready when the stored setup is current, and not_set_up once the definitions change", async () => {
    const { store, d } = await provisioned();
    expect(hostedAgentStatus(d)).toEqual({ state: "ready", error: null, checkedAt: store.state.checkedAt });
    expect(hostedAgentStatus({ ...d, cfg: testAgentConfig({ model: "claude-sonnet-5-5" }) }).state).toBe("not_set_up");
    expect(hostedAgentStatus({ ...d, keyFingerprint: () => FP2 }).state).toBe("not_set_up");
  });

  it("shows a stored error", async () => {
    const { fake, store, d } = setup();
    fake.fail("createEnvironment", apiError(403));
    await ensureProvisioned(d).catch(() => undefined);
    expect(hostedAgentStatus(d)).toEqual({ state: "error", error: NOT_ALLOWED, checkedAt: store.state.checkedAt });
  });

  it("never throws: an unreadable key is an error, an unreadable store is not_set_up", () => {
    const { d } = setup();
    expect(hostedAgentStatus({ ...d, keyFingerprint: () => { throw new Error("x"); } }))
      .toEqual({ state: "error", error: "The API key in use can't be read on this server.", checkedAt: null });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...d, store: { ...d.store, load: () => { throw new Error("db locked"); } } };
    expect(hostedAgentStatus(broken)).toEqual({ state: "not_set_up", error: null, checkedAt: null });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
