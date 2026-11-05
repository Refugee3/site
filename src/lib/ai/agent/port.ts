import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";
import type { AgentCreateParams, AgentUpdateParams, BetaManagedAgentsAgent } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type {
  BetaEnvironment,
  EnvironmentCreateParams,
  EnvironmentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type {
  BetaManagedAgentsSession,
  BetaManagedAgentsSessionUsage,
  SessionCreateParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";

// The only module that talks to the SDK's Managed Agents and Files namespaces. The rest of the engine works
// against AgentPort, so tests replace Anthropic with an in-memory fake (test-fake.ts) and never touch the network.

/** Request body without the header params the SDK adds itself. */
export type Body<T> = Omit<T, "betas" | "workspace_id">;
export interface CallOpts { signal?: AbortSignal; timeoutMs?: number }
export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";
export interface RemoteEnvironment { id: string; name: string; archivedAt: string | null }
export interface RemoteAgent { id: string; version: number; archivedAt: string | null }
export interface RemoteSession { id: string; status: SessionStatus; usage: BetaManagedAgentsSessionUsage | null; createdAt: string }
export interface EventStream extends AsyncIterable<BetaManagedAgentsStreamSessionEvents> { close(): void }

/** Everything the engine needs from Anthropic. SDK errors propagate unchanged (APIError subclasses). */
export interface AgentPort {
  createEnvironment(p: Body<EnvironmentCreateParams>, o?: CallOpts): Promise<RemoteEnvironment>;
  retrieveEnvironment(id: string, o?: CallOpts): Promise<RemoteEnvironment>;
  updateEnvironment(id: string, p: Body<EnvironmentUpdateParams>, o?: CallOpts): Promise<RemoteEnvironment>;
  /** First non-archived environment with exactly this name (walks every page), else null. */
  findEnvironmentByName(name: string, o?: CallOpts): Promise<RemoteEnvironment | null>;
  createAgent(p: Body<AgentCreateParams>, o?: CallOpts): Promise<RemoteAgent>;
  retrieveAgent(id: string, o?: CallOpts): Promise<RemoteAgent>;
  updateAgent(id: string, p: Body<AgentUpdateParams>, o?: CallOpts): Promise<RemoteAgent>;
  /** Files API (stable namespace): uploads a PDF under a generic name with an expiry. */
  uploadPdf(name: string, bytes: Uint8Array, expiresInSeconds: number, o?: CallOpts): Promise<{ id: string }>;
  deleteFile(id: string, o?: CallOpts): Promise<void>;
  createSession(p: Body<SessionCreateParams>, o?: CallOpts): Promise<RemoteSession>;
  retrieveSession(id: string, o?: CallOpts): Promise<RemoteSession>;
  deleteSession(id: string, o?: CallOpts): Promise<void>;
  /** Non-archived sessions of one agent created before `createdBefore` (RFC 3339), all pages. */
  listSessions(p: { agentId: string; createdBefore: string }, o?: CallOpts): AsyncIterable<RemoteSession>;
  /** Opens GET /v1/sessions/{id}/events/stream. Ends silently when `signal` aborts or close() is called. */
  streamEvents(sessionId: string, o: { signal: AbortSignal }): Promise<EventStream>;
  /** GET /v1/sessions/{id}/events, oldest first, all pages. */
  listEvents(sessionId: string, o?: CallOpts): AsyncIterable<BetaManagedAgentsSessionEvent>;
  sendEvents(sessionId: string, events: BetaManagedAgentsEventParams[], o?: CallOpts): Promise<void>;
}

/** The production port over one SDK client (built by U3 with the resolved key, authToken null, maxRetries 2). */
export function createSdkAgentPort(client: Anthropic): AgentPort {
  return {
    async createEnvironment(p, o) {
      return toEnvironment(await client.beta.environments.create(p, requestOptions(o)));
    },
    async retrieveEnvironment(id, o) {
      return toEnvironment(await client.beta.environments.retrieve(id, {}, requestOptions(o)));
    },
    async updateEnvironment(id, p, o) {
      return toEnvironment(await client.beta.environments.update(id, p, requestOptions(o)));
    },
    async findEnvironmentByName(name, o) {
      for await (const env of client.beta.environments.list({}, requestOptions(o))) {
        if (env.name === name && env.archived_at === null) return toEnvironment(env);
      }
      return null;
    },
    async createAgent(p, o) {
      return toAgent(await client.beta.agents.create(p, requestOptions(o)));
    },
    async retrieveAgent(id, o) {
      return toAgent(await client.beta.agents.retrieve(id, {}, requestOptions(o)));
    },
    async updateAgent(id, p, o) {
      return toAgent(await client.beta.agents.update(id, p, requestOptions(o)));
    },
    async uploadPdf(name, bytes, expiresInSeconds, o) {
      const file = await toFile(Buffer.from(bytes), name, { type: "application/pdf" });
      const uploaded = await client.files.upload({ file, expires_in_seconds: expiresInSeconds }, requestOptions(o));
      return { id: uploaded.id };
    },
    async deleteFile(id, o) {
      await client.files.delete(id, {}, requestOptions(o));
    },
    async createSession(p, o) {
      return toSession(await client.beta.sessions.create(p, requestOptions(o)));
    },
    async retrieveSession(id, o) {
      return toSession(await client.beta.sessions.retrieve(id, {}, requestOptions(o)));
    },
    async deleteSession(id, o) {
      await client.beta.sessions.delete(id, {}, requestOptions(o));
    },
    async *listSessions(p, o) {
      for await (const session of client.beta.sessions.list({ agent_id: p.agentId, "created_at[lt]": p.createdBefore }, requestOptions(o))) {
        yield toSession(session);
      }
    },
    async streamEvents(sessionId, o) {
      const stream = await client.beta.sessions.events.stream(sessionId, {}, { signal: o.signal });
      return {
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
        close: () => stream.controller.abort(),
      };
    },
    async *listEvents(sessionId, o) {
      yield* client.beta.sessions.events.list(sessionId, {}, requestOptions(o));
    },
    async sendEvents(sessionId, events, o) {
      await client.beta.sessions.events.send(sessionId, { events }, requestOptions(o));
    },
  };
}

/** CallOpts → the SDK's request options, leaving out what wasn't given so the client's defaults apply. */
function requestOptions(o: CallOpts | undefined): { signal?: AbortSignal; timeout?: number } {
  return {
    ...(o?.signal ? { signal: o.signal } : {}),
    ...(o?.timeoutMs !== undefined ? { timeout: o.timeoutMs } : {}),
  };
}

function toEnvironment(e: BetaEnvironment): RemoteEnvironment {
  return { id: e.id, name: e.name, archivedAt: e.archived_at };
}

function toAgent(a: BetaManagedAgentsAgent): RemoteAgent {
  return { id: a.id, version: a.version, archivedAt: a.archived_at };
}

function toSession(s: BetaManagedAgentsSession): RemoteSession {
  return { id: s.id, status: s.status, usage: s.usage ?? null, createdAt: s.created_at };
}
