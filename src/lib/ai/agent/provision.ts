import "server-only";
import { ConflictError, NotFoundError, PermissionDeniedError } from "@anthropic-ai/sdk";
import { AiError } from "../errors";
import {
  AGENT_ROLES,
  type AgentDefinition,
  agentDefinition,
  type AgentEngineConfig,
  type AgentRole,
  type EnvironmentDefinition,
  environmentDefinition,
} from "./definitions";
import { environmentNameTaken, provisioningError, teacherMessageFor } from "./errors";
import type { AgentPort } from "./port";

// Setup ("provisioning"): one environment and three agents per install and API key, created once and updated
// when their definitions change. Their ids live in the store (app_settings); "setting up" lives only in this
// process, so a crash mid-setup never leaves a stuck state.

export interface AgentStateSnapshot {
  installId: string;
  keyFp: string | null;
  environment: { id: string; hash: string } | null;
  agents: Partial<Record<AgentRole, { id: string; version: number; hash: string }>>;
  status: "none" | "ready" | "error";
  error: string | null;
  checkedAt: number | null;
}
export interface AgentProgress {
  keyFp: string;
  environment: { id: string; hash: string } | null;
  agents: Partial<Record<AgentRole, { id: string; version: number; hash: string }>>;
}
export interface AgentStateStore {
  load(): AgentStateSnapshot;
  saveReady(s: {
    keyFp: string;
    environment: { id: string; hash: string };
    agents: Record<AgentRole, { id: string; version: number; hash: string }>;
  }): void;
  saveError(message: string, progress?: AgentProgress): void;
}
export interface ProvisionDeps {
  port: AgentPort;
  store: AgentStateStore;
  cfg: AgentEngineConfig;
  /** apiKeyFingerprint(key in use), computed lazily by the caller. */
  keyFingerprint: () => string;
  now?: () => number;
}
export interface ProvisionedAgents {
  installId: string;
  environmentId: string;
  agents: Record<AgentRole, { id: string; version: number }>;
}
export interface HostedAgentStatus {
  state: "not_set_up" | "setting_up" | "ready" | "error";
  error: string | null;
  checkedAt: number | null;
}

/** One setup per key fingerprint at a time; `forced` setups re-check every remote object. */
interface Flight { promise: Promise<ProvisionedAgents>; forced: boolean }

export interface AgentProcessSlot {
  flights: Map<string, Flight>;
  /** Session ids this process is running; the stale-session sweep leaves them alone. */
  active: Set<string>;
  lastSweepAt: number;
}

// Process-wide globalThis slot so separate module copies share it (like pag.grader); the test setup deletes it.
const SLOT = Symbol.for("pag.agent");
const slots = globalThis as unknown as Record<symbol, AgentProcessSlot | undefined>;

export function agentProcessSlot(): AgentProcessSlot {
  slots[SLOT] ??= { flights: new Map(), active: new Set(), lastSweepAt: Number.NEGATIVE_INFINITY };
  return slots[SLOT];
}

/** Every setup call gets only a timeout: no caller's signal may cancel a setup that other jobs wait on. */
const SETUP_CALL = { timeoutMs: 30_000 } as const;
const SETUP_NOW_TIMEOUT_MS = 60_000;
const SETUP_TIMED_OUT = "Anthropic didn't answer in time. Try again in a minute.";
const KEY_UNREADABLE = "The API key in use can't be read on this server.";

interface Definitions { env: EnvironmentDefinition; agents: Record<AgentRole, AgentDefinition> }

let memo: { key: string; defs: Definitions } | null = null;

function definitionsFor(installId: string, cfg: Pick<AgentEngineConfig, "model" | "effort" | "scanEffort">): Definitions {
  const key = JSON.stringify([installId, cfg.model, cfg.effort, cfg.scanEffort]);
  if (memo?.key !== key) {
    const agents = Object.fromEntries(AGENT_ROLES.map((role) => [role, agentDefinition(role, cfg, installId)]));
    memo = { key, defs: { env: environmentDefinition(installId), agents: agents as Record<AgentRole, AgentDefinition> } };
  }
  return memo.defs;
}

/** The stored ids when they are current for this key and these definitions, else null. */
function currentAgents(state: AgentStateSnapshot, fp: string, defs: Definitions): ProvisionedAgents | null {
  if (state.status !== "ready" || state.keyFp !== fp || state.environment?.hash !== defs.env.hash) return null;
  const agents = {} as ProvisionedAgents["agents"];
  for (const role of AGENT_ROLES) {
    const agent = state.agents[role];
    if (agent?.hash !== defs.agents[role].hash) return null;
    agents[role] = { id: agent.id, version: agent.version };
  }
  return { installId: state.installId, environmentId: state.environment.id, agents };
}

/**
 * Fast path without any network call when the stored state is current; otherwise one single-flight setup per key.
 * `signal` only bounds this caller's wait (rejects with AiError "aborted"); it never cancels the shared flight.
 */
export function ensureProvisioned(d: ProvisionDeps, o: { force?: boolean; signal?: AbortSignal } = {}): Promise<ProvisionedAgents> {
  const result = acquire(d, o.force ?? false).catch((e: unknown) => {
    throw provisioningError(e);
  });
  return raceAbort(result, o.signal);
}

/** Fire-and-forget ensureProvisioned (errors are already recorded in the store). Never throws. */
export function startHostedAgentSetup(d: ProvisionDeps): void {
  ensureProvisioned(d).catch(() => undefined);
}

/** ensureProvisioned({ force: true }), waiting at most `timeoutMs` (default 60 000). Never throws. */
export async function setUpHostedAgentNow(
  d: ProvisionDeps,
  timeoutMs = SETUP_NOW_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const wait = new AbortController();
  const timer = setTimeout(() => wait.abort(), timeoutMs);
  try {
    await ensureProvisioned(d, { force: true, signal: wait.signal });
    return { ok: true };
  } catch (e) {
    const err = provisioningError(e);
    // The flight keeps running and records its own outcome, which Settings shows on the next refresh.
    if (err.code === "aborted" && wait.signal.aborted) return { ok: false, error: SETUP_TIMED_OUT };
    return { ok: false, error: teacherMessageFor(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** For Settings; never throws and never touches the network. */
export function hostedAgentStatus(d: Pick<ProvisionDeps, "store" | "cfg" | "keyFingerprint">): HostedAgentStatus {
  let fp: string;
  try {
    fp = d.keyFingerprint();
  } catch {
    return { state: "error", error: KEY_UNREADABLE, checkedAt: null };
  }
  try {
    if (agentProcessSlot().flights.has(fp)) return { state: "setting_up", error: null, checkedAt: null };
    const state = d.store.load();
    if (state.status === "error") return { state: "error", error: state.error, checkedAt: state.checkedAt };
    if (currentAgents(state, fp, definitionsFor(state.installId, d.cfg))) return { state: "ready", error: null, checkedAt: state.checkedAt };
  } catch (e) {
    console.error("[agent] couldn't read the hosted agent's setup state", e);
  }
  return { state: "not_set_up", error: null, checkedAt: null };
}

/**
 * Returns the current ids or joins/starts the setup flight. Everything up to registering a flight runs
 * synchronously, so two jobs that start together can never both start one.
 */
async function acquire(d: ProvisionDeps, force: boolean): Promise<ProvisionedAgents> {
  for (;;) {
    const fp = d.keyFingerprint();
    const state = d.store.load();
    const current = force ? null : currentAgents(state, fp, definitionsFor(state.installId, d.cfg));
    if (current) return current;
    const flights = agentProcessSlot().flights;
    const running = flights.get(fp);
    if (running && (!force || running.forced)) return running.promise;
    if (running) {
      // A forced setup must not trust a normal one that started before it: wait, then start (or join) a forced one.
      await running.promise.catch(() => undefined);
      continue;
    }
    const flight: Flight = { promise: provision(d, fp, force), forced: force };
    flights.set(fp, flight);
    const settle = () => {
      if (flights.get(fp) === flight) flights.delete(fp);
    };
    flight.promise.then(settle, settle);
    return flight.promise;
  }
}

async function provision(d: ProvisionDeps, fp: string, force: boolean): Promise<ProvisionedAgents> {
  // Loaded afresh: a flight that runs after another one must not use the snapshot taken before it.
  const state = d.store.load();
  const defs = definitionsFor(state.installId, d.cfg);
  const progress: AgentProgress = { keyFp: fp, environment: state.environment, agents: { ...state.agents } };
  try {
    // After an error, "ready" is only declared again once the remote objects were seen.
    if (force || state.keyFp !== fp || state.status === "error") await verify(d.port, progress, force);

    const environment = await ensureEnvironment(d.port, progress, defs.env);
    const agents = {} as Record<AgentRole, { id: string; version: number; hash: string }>;
    const ids = {} as ProvisionedAgents["agents"];
    for (const role of AGENT_ROLES) {
      agents[role] = await ensureAgent(d.port, progress, defs.agents[role]);
      ids[role] = { id: agents[role].id, version: agents[role].version };
    }
    d.store.saveReady({ keyFp: fp, environment, agents });
    return { installId: state.installId, environmentId: environment.id, agents: ids };
  } catch (e) {
    const err = provisioningError(e);
    // The partial progress is kept, so the next attempt doesn't create duplicates.
    if (err.code !== "aborted") {
      try {
        d.store.saveError(teacherMessageFor(err), progress);
      } catch (saveErr) {
        console.error("[agent] couldn't record the hosted agent's setup error", saveErr);
      }
    }
    throw err;
  }
}

/**
 * Keeps only the stored objects that still exist and aren't archived. An id from another workspace may answer
 * 404 or 403; if the key really can't use Managed Agents, the create that follows fails with the right 403.
 */
async function verify(port: AgentPort, progress: AgentProgress, force: boolean): Promise<void> {
  const env = progress.environment;
  if (env) {
    const remote = await retrieveOrNull(() => port.retrieveEnvironment(env.id, SETUP_CALL));
    progress.environment = remote === null || remote.archivedAt !== null ? null : { id: env.id, hash: force ? "" : env.hash };
  }
  for (const role of AGENT_ROLES) {
    const stored = progress.agents[role];
    if (!stored) continue;
    const remote = await retrieveOrNull(() => port.retrieveAgent(stored.id, SETUP_CALL));
    if (remote === null || remote.archivedAt !== null) delete progress.agents[role];
    // Edited in the Console: keep the id, re-apply our definition.
    else if (remote.version !== stored.version) progress.agents[role] = { id: stored.id, version: remote.version, hash: "" };
  }
}

async function retrieveOrNull<T>(retrieve: () => Promise<T>): Promise<T | null> {
  try {
    return await retrieve();
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof PermissionDeniedError) return null;
    throw e;
  }
}

async function ensureEnvironment(
  port: AgentPort,
  progress: AgentProgress,
  def: EnvironmentDefinition,
): Promise<{ id: string; hash: string }> {
  const stored = progress.environment;
  let env = stored ?? await createOrAdoptEnvironment(port, progress, def);
  if (env.hash !== def.hash) {
    try {
      await updateEnvironment(port, env.id, def);
    } catch (e) {
      // Gone since it was stored: create it instead.
      if (!(e instanceof NotFoundError) || stored === null) throw e;
      env = await createOrAdoptEnvironment(port, progress, def);
      if (env.hash !== def.hash) await updateEnvironment(port, env.id, def);
    }
  }
  progress.environment = { id: env.id, hash: def.hash };
  return progress.environment;
}

/** Creates the environment; a 409 means its name is taken (also after an SDK retry of a create that succeeded). */
async function createOrAdoptEnvironment(
  port: AgentPort,
  progress: AgentProgress,
  def: EnvironmentDefinition,
): Promise<{ id: string; hash: string }> {
  try {
    const created = await port.createEnvironment(def.params, SETUP_CALL);
    progress.environment = { id: created.id, hash: def.hash };
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    const found = await port.findEnvironmentByName(def.name, SETUP_CALL);
    if (found === null) throw environmentNameTaken(def.name);
    progress.environment = { id: found.id, hash: "" };
  }
  return progress.environment;
}

async function updateEnvironment(port: AgentPort, id: string, def: EnvironmentDefinition): Promise<void> {
  const { config, description, metadata } = def.params;
  await port.updateEnvironment(id, { config, description, metadata }, SETUP_CALL);
}

async function ensureAgent(
  port: AgentPort,
  progress: AgentProgress,
  def: AgentDefinition,
): Promise<{ id: string; version: number; hash: string }> {
  const stored = progress.agents[def.role];
  const remote = stored === undefined ? null : stored.hash === def.hash ? stored : await updateAgent(port, stored, def);
  const agent = remote ?? await port.createAgent(def.params, SETUP_CALL);
  const result = { id: agent.id, version: agent.version, hash: def.hash };
  progress.agents[def.role] = result;
  return result;
}

/**
 * Applies the definition at the stored version. A 409 means the version moved on: re-read it and retry once (a
 * second conflict is thrown). Null when the agent is gone or archived, so the caller creates a new one.
 */
async function updateAgent(
  port: AgentPort,
  stored: { id: string; version: number },
  def: AgentDefinition,
): Promise<{ id: string; version: number } | null> {
  try {
    try {
      return usable(await port.updateAgent(stored.id, { ...def.params, version: stored.version }, SETUP_CALL));
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      const current = await port.retrieveAgent(stored.id, SETUP_CALL);
      if (current.archivedAt !== null) return null;
      return usable(await port.updateAgent(stored.id, { ...def.params, version: current.version }, SETUP_CALL));
    }
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

function usable(agent: { id: string; version: number; archivedAt: string | null }): { id: string; version: number } | null {
  return agent.archivedAt === null ? agent : null;
}

/** Rejects this caller alone with "aborted" when its signal fires; the promise itself runs on. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AiError("aborted", "The grading job was stopped.", { retryable: true }));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
