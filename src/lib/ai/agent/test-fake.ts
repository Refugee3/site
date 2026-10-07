import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { EnvironmentCreateParams } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { BetaManagedAgentsSessionUsage, SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { AGENT_ROLES, type AgentEngineConfig } from "./definitions";
import type { AgentPort, Body, EventStream, RemoteSession, SessionStatus } from "./port";
import type { AgentProgress, AgentStateSnapshot, AgentStateStore, ProvisionedAgents } from "./provision";

// Tests only: an in-memory Managed Agents server behind the AgentPort interface. Sessions are driven by a
// per-test script that reacts to what the client does; any port method can be made to fail with an SDK error.

type WithoutServerFields<T> = T extends unknown ? Omit<T, "id" | "processed_at"> & { id?: string } : never;
/** An event as a test writes it: the fake assigns `id` (unless given) and `processed_at`. */
export type FakeEventInput = WithoutServerFields<BetaManagedAgentsSessionEvent>;
type Method = keyof AgentPort;

export interface FakeSession {
  readonly id: string;
  status: SessionStatus;
  usage: BetaManagedAgentsSessionUsage | null;
  readonly createdAt: string;
  readonly params: Body<SessionCreateParams>;
  /** Every event in server order: emitted ones and the client's events that landed. */
  readonly history: BetaManagedAgentsSessionEvent[];
  /** Appends events (status events also set `status`) and delivers them to the open streams; returns their ids. */
  emit(...events: FakeEventInput[]): string[];
  /** Like emit, but the open streams never deliver them, as if lost while a connection dropped: only the history has them. */
  miss(...events: FakeEventInput[]): string[];
  /** The server closes the open streams after delivering what they already hold. */
  dropStream(): void;
}

export interface FakeScript {
  /** After create: emit what the session does with its initial message (only history sees it). */
  onCreate?(s: FakeSession): void;
  /** After a client event landed. */
  onEvent?(s: FakeSession, event: BetaManagedAgentsEventParams): void;
  /** When the n-th stream (1-based) was opened, before any history was listed. */
  onStream?(s: FakeSession, n: number): void;
  /** When the n-th history listing (1-based) was taken: what is emitted now reaches only the stream. */
  onList?(s: FakeSession, n: number): void;
  /** Before each retrieveSession answers. */
  onRetrieve?(s: FakeSession): void;
}

interface Failure { method: Method; error: unknown; after: boolean; times: number; match?: (args: unknown[]) => boolean }

export interface FakeEnvironment { id: string; name: string; archived: boolean; params: Body<EnvironmentCreateParams> }
export interface FakeAgent { id: string; version: number; archived: boolean; params: Body<AgentCreateParams> }

/** An SDK error as the client would throw it for an HTTP status. */
export function apiError(status: number, message = `status ${status}`): APIError {
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error"
    : status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers());
}

/** Builders for the events tests emit most. */
export const events = {
  running: (): FakeEventInput => ({ type: "session.status_running" }),
  idle: (reason: "end_turn" | "budget_reached" | "retries_exhausted" | "refusal",
    stopDetails: BetaManagedAgentsSessionStatusIdleEvent["stop_details"] = null): FakeEventInput => ({
    type: "session.status_idle", stop_reason: { type: reason }, stop_details: stopDetails,
  }),
  requiresAction: (...eventIds: string[]): FakeEventInput => ({
    type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: eventIds }, stop_details: null,
  }),
  customToolUse: (name: string, input: Record<string, unknown>, id?: string): FakeEventInput => ({
    type: "agent.custom_tool_use", name, input, ...(id ? { id } : {}),
  }),
  toolUse: (name: string, permission: "allow" | "ask" | "deny", id?: string): FakeEventInput => ({
    type: "agent.tool_use", name, input: {}, evaluated_permission: permission, ...(id ? { id } : {}),
  }),
  error: (
    type: "unknown_error" | "model_overloaded_error" | "model_rate_limited_error" | "model_request_failed_error" | "billing_error",
    retry: "retrying" | "exhausted" | "terminal",
  ): FakeEventInput => ({ type: "session.error", error: { type, message: `${type} (test)`, retry_status: { type: retry } } }),
  terminated: (): FakeEventInput => ({ type: "session.status_terminated" }),
  deleted: (): FakeEventInput => ({ type: "session.deleted" }),
  message: (text: string): FakeEventInput => ({ type: "agent.message", content: [{ type: "text", text }] }),
  modelRequestEnd: (u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): FakeEventInput => ({
    type: "span.model_request_end", is_error: false, model_request_start_id: "sevt_start",
    model_usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead ?? 0,
      cache_creation_input_tokens: u.cacheWrite ?? 0 },
  }),
};

class FakeStream implements EventStream {
  private readonly queue: BetaManagedAgentsStreamSessionEvents[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  constructor(signal: AbortSignal) {
    if (signal.aborted) this.end(true);
    else signal.addEventListener("abort", () => this.end(true), { once: true });
  }

  push(event: BetaManagedAgentsStreamSessionEvents): void {
    if (this.ended) return;
    this.queue.push(event);
    this.notify();
  }

  /** Aborting drops what wasn't read yet, like the SDK; a server close delivers it first. */
  end(discard: boolean): void {
    if (discard) this.queue.length = 0;
    this.ended = true;
    this.notify();
  }

  close(): void {
    this.end(true);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<BetaManagedAgentsStreamSessionEvents> {
    for (;;) {
      const next = this.queue.shift();
      if (next) yield next;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

export function createFakeManagedAgents(o: { script?: FakeScript; now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  const calls: Array<{ method: Method; args: unknown[] }> = [];
  const environments = new Map<string, FakeEnvironment>();
  const agents = new Map<string, FakeAgent>();
  const files = new Map<string, Uint8Array>();
  const uploads: Array<{ id: string; name: string; expiresInSeconds: number }> = [];
  const sessions = new Map<string, FakeSession>();
  const deletedSessions = new Set<string>();
  const failures: Failure[] = [];
  const holds: Array<{ method: Method; gate: Promise<void> }> = [];
  const counters = new Map<string, number>();
  const streams = new Map<string, FakeStream[]>();
  const streamCount = new Map<string, number>();
  const listCount = new Map<string, number>();
  const fake = { script: o.script ?? {} };

  const nextId = (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${n}`;
  };
  const timestamp = () => new Date(now()).toISOString();
  const takeFailure = (method: Method, args: unknown[]) => {
    const at = failures.findIndex((f) => f.method === method && (f.match?.(args) ?? true));
    if (at === -1) return null;
    const failure = failures[at];
    if (--failure.times === 0) failures.splice(at, 1);
    return failure;
  };
  /** Records the call, waits while it is held, then fails before or after `apply` when a failure is queued for it. */
  async function call<T>(method: Method, args: unknown[], apply: () => T | Promise<T>): Promise<T> {
    calls.push({ method, args });
    const held = holds.findIndex((h) => h.method === method);
    if (held !== -1) await holds.splice(held, 1)[0].gate;
    const failure = takeFailure(method, args);
    if (failure && !failure.after) throw failure.error;
    const result = await apply();
    if (failure) throw failure.error;
    return result;
  }
  const notFound = (what: string) => apiError(404, `${what} not found`);

  const STATUS_OF: Partial<Record<BetaManagedAgentsSessionEvent["type"], SessionStatus>> = {
    "session.status_idle": "idle",
    "session.status_running": "running",
    "session.status_rescheduled": "rescheduling",
    "session.status_terminated": "terminated",
  };

  function newSession(params: Body<SessionCreateParams>, status: SessionStatus): FakeSession {
    const id = nextId("sesn");
    const history: BetaManagedAgentsSessionEvent[] = [];
    const append = (event: FakeEventInput) => {
      const full = { ...event, id: event.id ?? nextId("sevt"), processed_at: timestamp() } as BetaManagedAgentsSessionEvent;
      history.push(full);
      session.status = STATUS_OF[full.type] ?? session.status;
      return full;
    };
    const session: FakeSession = {
      id, status, usage: null, createdAt: timestamp(), params, history,
      emit(...input) {
        return input.map((event) => {
          const full = append(event);
          // The SDK's stream filters events by name and never yields session.usage.
          if (full.type !== "session.usage") for (const stream of streams.get(id) ?? []) stream.push(full);
          return full.id;
        });
      },
      miss(...input) {
        return input.map((event) => append(event).id);
      },
      dropStream() {
        for (const stream of streams.get(id) ?? []) stream.end(false);
        streams.set(id, []);
      },
    };
    sessions.set(id, session);
    return session;
  }

  function sessionOrThrow(id: string): FakeSession {
    const session = sessions.get(id);
    if (!session) throw notFound(`session ${id}`);
    return session;
  }

  const port: AgentPort = {
    createEnvironment: (p, opts) => call("createEnvironment", [p, opts], () => {
      if ([...environments.values()].some((e) => e.name === p.name)) throw apiError(409, `An environment named ${p.name} already exists.`);
      const env: FakeEnvironment = { id: nextId("env"), name: p.name, archived: false, params: p };
      environments.set(env.id, env);
      return { id: env.id, name: env.name, archivedAt: null };
    }),
    retrieveEnvironment: (id, opts) => call("retrieveEnvironment", [id, opts], () => {
      const env = environments.get(id);
      if (!env) throw notFound(`environment ${id}`);
      return { id, name: env.name, archivedAt: env.archived ? timestamp() : null };
    }),
    updateEnvironment: (id, p, opts) => call("updateEnvironment", [id, p, opts], () => {
      const env = environments.get(id);
      if (!env) throw notFound(`environment ${id}`);
      return { id, name: env.name, archivedAt: env.archived ? timestamp() : null };
    }),
    findEnvironmentByName: (name, opts) => call("findEnvironmentByName", [name, opts], () => {
      const env = [...environments.values()].find((e) => e.name === name && !e.archived);
      return env ? { id: env.id, name: env.name, archivedAt: null } : null;
    }),
    createAgent: (p, opts) => call("createAgent", [p, opts], () => {
      const agent: FakeAgent = { id: nextId("agent"), version: 1, archived: false, params: p };
      agents.set(agent.id, agent);
      return { id: agent.id, version: 1, archivedAt: null };
    }),
    retrieveAgent: (id, opts) => call("retrieveAgent", [id, opts], () => {
      const agent = agents.get(id);
      if (!agent) throw notFound(`agent ${id}`);
      return { id, version: agent.version, archivedAt: agent.archived ? timestamp() : null };
    }),
    updateAgent: (id, p, opts) => call("updateAgent", [id, p, opts], () => {
      const agent = agents.get(id);
      if (!agent) throw notFound(`agent ${id}`);
      if (p.version !== undefined && p.version !== agent.version) throw apiError(409, `agent ${id} is at version ${agent.version}`);
      agent.version += 1;
      return { id, version: agent.version, archivedAt: agent.archived ? timestamp() : null };
    }),
    uploadPdf: (name, bytes, expiresInSeconds, opts) => call("uploadPdf", [name, bytes, expiresInSeconds, opts], () => {
      const id = nextId("file");
      files.set(id, bytes);
      uploads.push({ id, name, expiresInSeconds });
      return { id };
    }),
    deleteFile: (id, opts) => call("deleteFile", [id, opts], () => {
      if (!files.delete(id)) throw notFound(`file ${id}`);
    }),
    createSession: (p, opts) => call("createSession", [p, opts], () => {
      const agentId = typeof p.agent === "string" ? p.agent : p.agent.id;
      const env = environments.get(p.environment_id);
      const agent = agents.get(agentId);
      if (!env) throw notFound(`environment ${p.environment_id}`);
      if (!agent) throw notFound(`agent ${agentId}`);
      if (env.archived || agent.archived) throw apiError(400, "The agent or environment is archived.");
      for (const r of p.resources ?? []) if (r.type === "file" && !files.has(r.file_id)) throw notFound(`file ${r.file_id}`);
      const session = newSession(p, (p.initial_events ?? []).length > 0 ? "running" : "idle");
      fake.script.onCreate?.(session);
      return snapshot(session);
    }),
    retrieveSession: (id, opts) => call("retrieveSession", [id, opts], () => {
      const session = sessionOrThrow(id);
      fake.script.onRetrieve?.(session);
      return snapshot(session);
    }),
    deleteSession: (id, opts) => call("deleteSession", [id, opts], () => {
      const session = sessionOrThrow(id);
      if (session.status === "running" || session.status === "rescheduling") throw apiError(400, "Cannot delete a running session.");
      session.dropStream();
      sessions.delete(id);
      deletedSessions.add(id);
    }),
    listSessions: (p, opts) => {
      calls.push({ method: "listSessions", args: [p, opts] });
      const failure = takeFailure("listSessions", [p, opts]);
      const found = [...sessions.values()].filter((s) => agentOf(s) === p.agentId && s.createdAt < p.createdBefore).map(snapshot);
      return (async function* () {
        if (failure) throw failure.error;
        yield* found;
      })();
    },
    streamEvents: (sessionId, opts) => call("streamEvents", [sessionId, opts], () => {
      const session = sessionOrThrow(sessionId);
      const stream = new FakeStream(opts.signal);
      streams.set(sessionId, [...(streams.get(sessionId) ?? []), stream]);
      const n = (streamCount.get(sessionId) ?? 0) + 1;
      streamCount.set(sessionId, n);
      fake.script.onStream?.(session, n);
      return stream;
    }),
    listEvents: (sessionId, opts) => {
      calls.push({ method: "listEvents", args: [sessionId, opts] });
      const failure = takeFailure("listEvents", [sessionId, opts]);
      const session = sessions.get(sessionId);
      const taken = session ? [...session.history] : [];
      if (session) {
        const n = (listCount.get(sessionId) ?? 0) + 1;
        listCount.set(sessionId, n);
        fake.script.onList?.(session, n);
      }
      return (async function* () {
        if (failure) throw failure.error;
        if (!session) throw notFound(`session ${sessionId}`);
        for (const event of taken) {
          if (opts?.signal?.aborted) throw new APIUserAbortError();
          yield event;
        }
      })();
    },
    sendEvents: (sessionId, sent, opts) => call("sendEvents", [sessionId, sent, opts], () => {
      const session = sessionOrThrow(sessionId);
      for (const event of sent) {
        session.emit({ ...event } as FakeEventInput);
        if (event.type === "user.interrupt" && (session.status === "running" || session.status === "rescheduling")) {
          session.emit(events.idle("end_turn"));
        }
        fake.script.onEvent?.(session, event);
      }
    }),
  };

  function agentOf(s: FakeSession): string {
    return typeof s.params.agent === "string" ? s.params.agent : s.params.agent.id;
  }

  function snapshot(s: FakeSession): RemoteSession {
    return { id: s.id, status: s.status, usage: s.usage, createdAt: s.createdAt };
  }

  return Object.assign(fake, {
    port,
    calls,
    environments,
    agents,
    files,
    uploads,
    sessions,
    deletedSessions,
    /** The methods called, in order. */
    methods: () => calls.map((c) => c.method),
    /** Every event batch the client sent with sendEvents, flattened, including ones that failed. */
    sent: () => calls.filter((c) => c.method === "sendEvents").flatMap((c) => c.args[1] as BetaManagedAgentsEventParams[]),
    /** Makes the next matching call(s) of `method` throw `error`; with `after`, the call takes effect first (a reply that landed). */
    fail(method: Method, error: unknown, opts: { after?: boolean; times?: number; match?: (args: unknown[]) => boolean } = {}) {
      failures.push({ method, error, after: opts.after ?? false, times: opts.times ?? 1, match: opts.match });
    },
    /** The next call of `method` waits (after being recorded) until release() is called. */
    hold(method: Method): { release: () => void } {
      let release = () => {};
      holds.push({ method, gate: new Promise<void>((resolve) => { release = resolve; }) });
      return { release: () => release() };
    },
    /** Creates an environment and the three agents directly (no calls recorded), as a finished setup would. */
    seedProvisioned(installId = "a1b2c3d4e5f6"): ProvisionedAgents {
      const env: FakeEnvironment = {
        id: nextId("env"), name: `pdf-autograder-${installId}`, archived: false, params: { name: "seeded" },
      };
      environments.set(env.id, env);
      const ids = {} as ProvisionedAgents["agents"];
      for (const role of AGENT_ROLES) {
        const agent: FakeAgent = {
          id: nextId("agent"), version: 1, archived: false, params: { name: role, model: "claude-opus-5-5" },
        };
        agents.set(agent.id, agent);
        ids[role] = { id: agent.id, version: 1 };
      }
      return { installId, environmentId: env.id, agents: ids };
    },
  });
}

export type FakeManagedAgents = ReturnType<typeof createFakeManagedAgents>;

export interface MemoryStore extends AgentStateStore {
  state: AgentStateSnapshot;
  saves: Array<{ kind: "ready" | "error"; message?: string; progress?: AgentProgress }>;
}

/** An AgentStateStore in memory, recording what was saved; load() returns a copy, as a database read would. */
export function memoryStore(initial: Partial<AgentStateSnapshot> = {}): MemoryStore {
  const store: MemoryStore = {
    state: {
      installId: "a1b2c3d4e5f6", keyFp: null, environment: null, agents: {}, status: "none", error: null, checkedAt: null, ...initial,
    },
    saves: [],
    load: () => structuredClone(store.state),
    saveReady(s) {
      store.saves.push({ kind: "ready" });
      store.state = { ...store.state, ...structuredClone(s), status: "ready", error: null, checkedAt: Date.now() };
    },
    saveError(message, progress) {
      store.saves.push({ kind: "error", message, progress: structuredClone(progress) });
      store.state = {
        ...store.state, ...(progress ? structuredClone(progress) : {}), status: "error", error: message.trim().slice(0, 500), checkedAt: Date.now(),
      };
    },
  };
  return store;
}

/** Opus 5.5 for extract and grade, so a test can tell it from the scan splitter's Sonnet 5.5. */
export function testAgentConfig(overrides: Partial<AgentEngineConfig> = {}): AgentEngineConfig {
  return {
    model: "claude-opus-5-5", scanModel: "claude-sonnet-5-5", effort: "high", scanEffort: "medium",
    budgetCents: { extract: 300, grade: 200, scan: 150 }, sessionTimeoutMs: 1_200_000, keepSessions: false, maxTokens: 64_000,
    ...overrides,
  };
}
