import "server-only";
import { APIConnectionError, APIError, BadRequestError, NotFoundError } from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsUserCustomToolResultEventParams,
  BetaManagedAgentsUserToolConfirmationEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { BetaManagedAgentsSessionUsage, SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type * as z from "zod";
import { truncateChars } from "@/lib/grading/text";
import type { AiUsage } from "@/lib/types";
import { type AgentCallCost, AiError } from "../errors";
import { type AgentEngineConfig, type AgentRole, roleModel, SUBMIT_TOOL } from "./definitions";
import { apiMessage, sessionCallError, sessionErrorToAiError } from "./errors";
import type { AgentPort, Body, RemoteSession, SessionStatus } from "./port";
import { SUBMIT_ACCEPTED, SUBMIT_ALREADY_ACCEPTED, submitNudge, submitRejected, TOOL_ASK_DENIED } from "./prompts";
import { agentProcessSlot, type ProvisionedAgents } from "./provision";

// One task = one session: upload the PDFs, create the session with everything in its initial message, read its
// events until the agent hands in a valid result through the submit tool, then delete the session and uploads.
// Event payloads contain student work and are never logged.

export const MAX_SUBMISSIONS = 3;        // submissions per session; the 3rd zod-valid one is accepted even with semantic problems
export const MAX_NUDGES = 1;             // "you ended without calling the submit tool"
export const GRACE_MS = 60_000;          // after acceptance, wait this long for the turn to end
export const STREAM_IDLE_MS = 300_000;   // no event for this long → reconnect
export const MAX_RECONNECTS = 8;         // consecutive, reset by progress; backoff 500 ms × 2^(n-1), at most 10 s
export const CLEANUP_BUDGET_MS = 30_000;
export const SWEEP_INTERVAL_MS = 3_600_000;

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "document"; title?: string; context?: string; source: { type: "file"; file_id: string } };

export interface AgentTaskSpec<T> {
  role: AgentRole;
  /** Session title; never contains student data. */
  title: string;
  /** Uploaded with generic names and mounted read-only, in this order. */
  files: Array<{ uploadName: string; mount: string; bytes: Uint8Array }>;
  /** The single initial user.message; `fileIds[i]` is the upload id of files[i]. */
  content(fileIds: string[]): UserContentBlock[];
  schema: z.ZodType<T>;
  /** Semantic problems with a schema-valid submission (empty = fine), e.g. wrong refs or page count. */
  check?(output: T): string[];
  budgetCents: number;
}
export interface AgentTaskResult<T> {
  output: T;
  usage: AiUsage;
  cost: AgentCallCost;
  sessionId: string;
  durationMs: number;
}
export interface RunDeps {
  port: AgentPort;
  cfg: AgentEngineConfig;
  provisioned: ProvisionedAgents;
  /** Re-provisions with force (used once when the agent or environment is gone at session create). */
  reprovision(): Promise<ProvisionedAgents>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const UPLOAD_CALL = { timeoutMs: 120_000 } as const;
const CREATE_CALL = { timeoutMs: 60_000 } as const;
const RUN_CALL = { timeoutMs: 30_000 } as const;
const CLEANUP_CALL = { timeoutMs: 10_000 } as const;
const KEEP_UPLOADS_SECONDS = 604_800;
const MIN_UPLOAD_SECONDS = 3600;
const UPLOAD_MARGIN_SECONDS = 900;
const CLEANUP_POLLS = 20;
const CLEANUP_POLL_MS = 500;
const MAX_PROBLEM_LINES = 20;
const PROBLEM_MAX_CHARS = 200;
const SWEEP_MARGIN_MS = 600_000;

type Reply = BetaManagedAgentsUserCustomToolResultEventParams | BetaManagedAgentsUserToolConfirmationEventParams;
type Spent = { usage: AiUsage; cost: AgentCallCost };

/** Runs one task to completion (§6). Rejects only with AiError; after the session exists, the error carries `billed`. */
export function runAgentTask<T>(d: RunDeps, spec: AgentTaskSpec<T>, o: { signal?: AbortSignal } = {}): Promise<AgentTaskResult<T>> {
  return new TaskRun(d, spec, o.signal).run();
}

/** Deletes this install's sessions older than the cutoff that this process isn't running (§6.8). Returns how many. */
export async function sweepStaleSessions(d: {
  port: AgentPort;
  agentIds: string[];
  createdBefore: Date;
  active: ReadonlySet<string>;
}): Promise<number> {
  let deleted = 0;
  for (const agentId of d.agentIds) {
    try {
      for await (const session of d.port.listSessions({ agentId, createdBefore: d.createdBefore.toISOString() }, RUN_CALL)) {
        if (d.active.has(session.id)) continue;
        try {
          // A running session can't be deleted: stop it now, a later sweep deletes it.
          if (session.status === "running" || session.status === "rescheduling") {
            await d.port.sendEvents(session.id, [{ type: "user.interrupt" }], RUN_CALL);
          } else {
            await d.port.deleteSession(session.id, RUN_CALL);
            deleted++;
          }
        } catch (e) {
          if (!(e instanceof NotFoundError)) console.warn(`[agent] the sweep couldn't remove session ${session.id}: ${errorText(e)}`);
        }
      }
    } catch (e) {
      console.warn(`[agent] the sweep couldn't list the sessions of agent ${agentId}: ${errorText(e)}`);
    }
  }
  return deleted;
}

/** The cutoff the sweep uses: a session older than this can't belong to a task that is still running. */
export function sweepCutoff(now: number, cfg: Pick<AgentEngineConfig, "sessionTimeoutMs">): Date {
  return new Date(now - (cfg.sessionTimeoutMs + SWEEP_MARGIN_MS));
}

/** Session usage → our AiUsage (+ list cost and running time). */
export function toAgentUsage(u: BetaManagedAgentsSessionUsage | null | undefined): { usage: AiUsage; cost: AgentCallCost } {
  const listCost = u?.list_cost;
  return {
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: (u?.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (u?.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    },
    cost: {
      listCostCents: listCost?.currency === "USD" && /^\d+$/.test(listCost.amount) ? Number(listCost.amount) : null,
      activeSeconds: Math.round(u?.active_seconds ?? 0),
    },
  };
}

class TaskRun<T> {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly tool: string;
  private readonly startedAt: number;
  /** Aborted by the per-session timer started at CREATE (a setTimeout, which fake timers drive). */
  private readonly sessionTimer = new AbortController();
  /** Aborted GRACE_MS after acceptance: stop waiting for the turn to end. */
  private readonly grace = new AbortController();
  private readonly taskSignal: AbortSignal;
  private sessionTimeout: ReturnType<typeof setTimeout> | undefined;
  private graceTimeout: ReturnType<typeof setTimeout> | undefined;
  private watchdog: { controller: AbortController; timer?: ReturnType<typeof setTimeout> } | null = null;

  private readonly uploads: string[] = [];
  private sessionId: string | null = null;
  private lastStatus: SessionStatus | null = null;

  private readonly seen = new Set<string>();
  private readonly answered = new Set<string>();
  /** Replies built once and not yet confirmed sent, keyed by the tool use they answer. */
  private readonly pending = new Map<string, Reply>();
  private accepted: { output: T } | null = null;
  private rejected = 0;
  private nudges = 0;
  private reconnects = 0;
  /** The turn ended after acceptance: stop reading. */
  private done = false;
  /** Break the stream and reconnect, so the history shows what was missed or whether a reply landed. */
  private resync = false;
  private inHistory = false;
  private lastError: BetaManagedAgentsSessionErrorEvent | null = null;
  private readonly spanUsage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(
    private readonly d: RunDeps,
    private readonly spec: AgentTaskSpec<T>,
    private readonly jobSignal: AbortSignal | undefined,
  ) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? sleep;
    this.tool = SUBMIT_TOOL[spec.role];
    this.startedAt = this.now();
    this.taskSignal = AbortSignal.any([...(jobSignal ? [jobSignal] : []), this.sessionTimer.signal]);
  }

  async run(): Promise<AgentTaskResult<T>> {
    let outcome: { ok: true; output: T; sessionId: string } | { ok: false; error: AiError };
    try {
      outcome = { ok: true, ...await this.execute() };
    } catch (e) {
      outcome = { ok: false, error: sessionCallError(e) };
    }
    const durationMs = Math.round(this.now() - this.startedAt);
    const spent = await this.cleanup(outcome.ok ? "succeeded" : `failed (${outcome.error.code})`, durationMs);
    if (!outcome.ok) throw this.withBilled(outcome.error, spent);
    return { output: outcome.output, usage: spent.usage, cost: spent.cost, sessionId: outcome.sessionId, durationMs };
  }

  private async execute(): Promise<{ output: T; sessionId: string }> {
    const { port, cfg } = this.d;
    const expiresIn = cfg.keepSessions
      ? KEEP_UPLOADS_SECONDS
      : Math.max(MIN_UPLOAD_SECONDS, Math.ceil(cfg.sessionTimeoutMs / 1000) + UPLOAD_MARGIN_SECONDS);
    // Uploads and the create get no abort signal: aborting them mid-request could leave a file or session
    // whose id the runner never learns. The signal is checked after each instead.
    for (const file of this.spec.files) {
      this.throwIfAborted();
      const uploaded = await port.uploadPdf(file.uploadName, file.bytes, expiresIn, UPLOAD_CALL);
      this.uploads.push(uploaded.id);
    }
    this.throwIfAborted();
    this.sessionTimeout = setTimeout(() => this.sessionTimer.abort(), cfg.sessionTimeoutMs);
    const session = await this.createSession();
    this.sessionId = session.id;
    this.lastStatus = session.status;
    agentProcessSlot().active.add(session.id);
    this.throwIfAborted();
    return { output: await this.read(session.id), sessionId: session.id };
  }

  /**
   * A 404, or a 400 naming an archived object, means the setup is stale: re-provision once (forced, so the
   * environment and agents are re-checked and re-created if gone) and create again. The same error right after
   * that is not the setup's fault and must not pause the worker.
   */
  private async createSession(): Promise<RemoteSession> {
    let provisioned = this.d.provisioned;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.d.port.createSession(this.sessionBody(provisioned), CREATE_CALL);
      } catch (e) {
        const gone = e instanceof NotFoundError || (e instanceof BadRequestError && /archived/i.test(apiMessage(e)));
        if (!gone) throw sessionCallError(e);
        if (attempt > 1) {
          if (e instanceof NotFoundError) {
            throw new AiError("server_error", "Anthropic couldn't start a session for the hosted agent (not found).", { retryable: true });
          }
          throw sessionCallError(e);
        }
        provisioned = await this.d.reprovision();
      }
    }
  }

  private sessionBody(p: ProvisionedAgents): Body<SessionCreateParams> {
    const { role } = this.spec;
    return {
      agent: { type: "agent", id: p.agents[role].id, version: p.agents[role].version },
      environment_id: p.environmentId,
      title: this.spec.title,
      metadata: { app: "pdf-autograder", install: p.installId, role },
      resources: this.uploads.map((id, i) => ({ type: "file", file_id: id, mount_path: this.spec.files[i].mount })),
      budget: { type: "limit", max_list_cost: { amount: String(this.spec.budgetCents), currency: "USD" } },
      initial_events: [{ type: "user.message", content: this.spec.content([...this.uploads]) }],
    };
  }

  /** CONNECT ⇄ RUN until a submission is accepted (§6.3). */
  private async read(sessionId: string): Promise<T> {
    for (;;) {
      await this.connect(sessionId);
      // After acceptance nothing else can fail the task: any end of reading is the end.
      if (this.accepted) return this.accepted.output;
      this.throwIfAborted();
      this.reconnects++;
      if (this.reconnects > MAX_RECONNECTS) {
        throw new AiError("connection", "Lost the connection to the hosted agent too many times.", { retryable: true });
      }
      await this.sleep(Math.min(500 * 2 ** (this.reconnects - 1), 10_000), this.taskSignal);
      this.throwIfAborted();
    }
  }

  /**
   * One connection: the stream is opened first, then the full history is read through process() (there is no
   * replay), pending replies are re-sent, and the live stream is tailed. Returns when the reading should end or
   * be reconnected; throws only what fails the task.
   */
  private async connect(sessionId: string): Promise<void> {
    const watchdog: { controller: AbortController; timer?: ReturnType<typeof setTimeout> } = { controller: new AbortController() };
    this.watchdog = watchdog;
    this.rearmWatchdog();
    const signal = AbortSignal.any([this.taskSignal, this.grace.signal, watchdog.controller.signal]);
    this.resync = false;
    let stream: Awaited<ReturnType<AgentPort["streamEvents"]>> | null = null;
    try {
      stream = await this.d.port.streamEvents(sessionId, { signal });
      this.inHistory = true;
      for await (const event of this.d.port.listEvents(sessionId, { signal, timeoutMs: RUN_CALL.timeoutMs })) {
        await this.process(event);
        if (this.done) return;
      }
      this.inHistory = false;
      // A reply whose send failed during this pass is re-sent only after a newer history shows it didn't land.
      if (this.resync) return;
      for (const id of [...this.pending.keys()]) await this.sendReply(id);
      if (this.resync) return;
      for await (const event of stream) {
        await this.process(event);
        if (this.done || this.resync) return;
      }
    } catch (e) {
      if (this.accepted) return;
      if (!(e instanceof AiError) && (signal.aborted || isDroppedConnection(e))) return;
      throw sessionCallError(e);
    } finally {
      this.inHistory = false;
      clearTimeout(watchdog.timer);
      this.watchdog = null;
      stream?.close();
    }
  }

  private rearmWatchdog(): void {
    const watchdog = this.watchdog;
    if (!watchdog) return;
    clearTimeout(watchdog.timer);
    watchdog.timer = setTimeout(() => watchdog.controller.abort(), STREAM_IDLE_MS);
  }

  /** Dedupe by id, then handle. The exit condition is state (`done`), so a replayed event is never handled twice. */
  private async process(event: BetaManagedAgentsStreamSessionEvents | BetaManagedAgentsSessionEvent): Promise<void> {
    this.rearmWatchdog();
    if (!("id" in event) || !event.id || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    this.reconnects = 0;
    await this.handle(event);
  }

  private async handle(event: BetaManagedAgentsSessionEvent): Promise<void> {
    switch (event.type) {
      case "user.custom_tool_result":
        this.landed(event.custom_tool_use_id);
        return;
      case "user.tool_confirmation":
        this.landed(event.tool_use_id);
        return;
      case "agent.custom_tool_use":
        return this.onCustomToolUse(event.id, event.name, event.input);
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        // Unattended: a call the `auto` policy couldn't decide is denied (auto-denied calls never reach us).
        if (event.evaluated_permission === "ask" && !this.answered.has(event.id)) {
          await this.reply(event.id, { type: "user.tool_confirmation", tool_use_id: event.id, result: "deny", deny_message: TOOL_ASK_DENIED });
        }
        return;
      case "session.error":
        this.lastError = event;
        if (event.error.type === "billing_error") {
          this.finishOr(() => sessionErrorToAiError(event, "Anthropic reports a billing problem."));
        } else if (event.error.retry_status.type === "retrying") {
          console.info(`[agent] ${this.spec.role}: session ${this.sessionId} reported ${event.error.type}; Anthropic is retrying`);
        }
        return;
      case "span.model_request_end":
        this.spanUsage.inputTokens += event.model_usage.input_tokens;
        this.spanUsage.outputTokens += event.model_usage.output_tokens;
        this.spanUsage.cacheReadTokens += event.model_usage.cache_read_input_tokens;
        this.spanUsage.cacheWriteTokens += event.model_usage.cache_creation_input_tokens;
        return;
      case "session.status_idle":
        this.lastStatus = "idle";
        return this.onIdle(event);
      case "session.status_running":
        this.lastStatus = "running";
        return;
      case "session.status_rescheduled":
        this.lastStatus = "rescheduling";
        return;
      case "session.status_terminated":
        this.lastStatus = "terminated";
        this.finishOr(() => sessionErrorToAiError(this.lastError, "The hosted agent's session ended before it submitted an answer."));
        return;
      case "session.deleted":
        this.finishOr(() => new AiError("server_error", "The hosted agent's session was deleted.", { retryable: true }));
        return;
      default:
        return;
    }
  }

  private async onCustomToolUse(id: string, name: string, input: unknown): Promise<void> {
    if (this.answered.has(id)) return;
    const answer = name !== this.tool
      ? { text: `Unknown tool. Use ${this.tool}.`, isError: true }
      : this.accepted ? { text: SUBMIT_ALREADY_ACCEPTED, isError: false } : this.validate(input);
    await this.reply(id, {
      type: "user.custom_tool_result", custom_tool_use_id: id, content: [{ type: "text", text: answer.text }], is_error: answer.isError,
    });
  }

  /** §6.4: zod first, then the task's own check; the last allowed schema-valid submission is accepted as it is. */
  private validate(input: unknown): { text: string; isError: boolean } {
    const parsed = this.spec.schema.safeParse(input);
    if (!parsed.success) {
      this.rejected++;
      const problems = zodProblems(parsed.error.issues);
      if (this.rejected >= MAX_SUBMISSIONS) {
        throw new AiError("invalid_output",
          `The hosted agent's answer didn't match the required form after ${MAX_SUBMISSIONS} attempts: ${problems[0]}`, { retryable: true });
      }
      return { text: submitRejected(this.tool, this.rejected, MAX_SUBMISSIONS, problems), isError: true };
    }
    const problems = this.spec.check?.(parsed.data) ?? [];
    if (problems.length > 0 && this.rejected + 1 < MAX_SUBMISSIONS) {
      this.rejected++;
      return { text: submitRejected(this.tool, this.rejected, MAX_SUBMISSIONS, problems), isError: true };
    }
    this.accepted = { output: parsed.data };
    this.graceTimeout = setTimeout(() => this.grace.abort(), GRACE_MS);
    return { text: SUBMIT_ACCEPTED, isError: false };
  }

  private async onIdle(event: BetaManagedAgentsSessionStatusIdleEvent): Promise<void> {
    const reason = event.stop_reason;
    switch (reason.type) {
      case "requires_action":
        // Never finishes the task. The history is complete up to now, and its pending replies are re-sent right after it.
        if (this.inHistory) return;
        for (const id of reason.event_ids) {
          if (!this.seen.has(id)) this.resync = true;
          else if (this.pending.has(id)) await this.sendReply(id);
        }
        return;
      case "end_turn":
        if (this.accepted) {
          this.done = true;
        } else if (this.nudges < MAX_NUDGES) {
          this.nudges++;
          await this.send([{ type: "user.message", content: [{ type: "text", text: submitNudge(this.tool) }] }]);
        } else {
          throw new AiError("invalid_output", "The hosted agent finished without submitting an answer.", { retryable: true });
        }
        return;
      case "budget_reached":
        this.finishOr(() => new AiError("budget_reached", "The hosted agent reached its spending cap for this task.", { retryable: true }));
        return;
      case "retries_exhausted":
        this.finishOr(() => sessionErrorToAiError(this.lastError, "The hosted agent stopped after repeated errors."));
        return;
      case "refusal":
        this.finishOr(() => new AiError("refusal", "The hosted agent declined to answer.", {
          retryable: false,
          refusalCategory: event.stop_details?.category ?? null,
        }));
        return;
      default:
        if (this.accepted) this.done = true;
    }
  }

  /** After acceptance the turn's end only ends the reading; before it, `error()` fails the task. */
  private finishOr(error: () => AiError): void {
    if (!this.accepted) throw error();
    this.done = true;
  }

  private async reply(toolUseId: string, event: Reply): Promise<void> {
    this.pending.set(toolUseId, event);
    await this.sendReply(toolUseId);
  }

  /**
   * Sends a pending reply as the same object every time. Only auth / agent_unavailable failures are fatal: any
   * other (including a 400/409 because the SDK's retry repeated a reply that had already landed) leaves it pending
   * and reconnects, so the history shows whether it landed and otherwise it is sent again.
   */
  private async sendReply(toolUseId: string): Promise<void> {
    const event = this.pending.get(toolUseId);
    if (!event || this.sessionId === null) return;
    try {
      await this.d.port.sendEvents(this.sessionId, [event], RUN_CALL);
      this.landed(toolUseId);
    } catch (e) {
      const err = sessionCallError(e);
      if (err.code === "auth" || err.code === "agent_unavailable") throw err;
      console.warn(`[agent] ${this.spec.role}: a tool reply to session ${this.sessionId} wasn't confirmed (${err.code}); checking the session again`);
      this.resync = true;
    }
  }

  private landed(toolUseId: string): void {
    this.pending.delete(toolUseId);
    this.answered.add(toolUseId);
  }

  private async send(events: BetaManagedAgentsEventParams[]): Promise<void> {
    if (this.sessionId === null) return;
    try {
      await this.d.port.sendEvents(this.sessionId, events, RUN_CALL);
    } catch (e) {
      throw sessionCallError(e);
    }
  }

  private throwIfAborted(): void {
    if (!this.taskSignal.aborted) return;
    if (this.jobSignal?.aborted) throw new AiError("aborted", "The grading job was stopped.", { retryable: true });
    const minutes = Math.round(this.d.cfg.sessionTimeoutMs / 60_000);
    throw new AiError("timeout", `The hosted agent took longer than ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, { retryable: true });
  }

  /**
   * §6.7, success or failure, with its own budget and never the aborted signal: stop the session, read its usage once
   * it has settled, then delete it and the uploads (unless AGENT_KEEP_SESSIONS=1). Never throws.
   */
  private async cleanup(outcome: string, durationMs: number): Promise<Spent> {
    clearTimeout(this.sessionTimeout);
    clearTimeout(this.graceTimeout);
    const { port, cfg } = this.d;
    const deadline = this.now() + CLEANUP_BUDGET_MS;
    const inBudget = () => this.now() < deadline;
    let spent: Spent = { usage: { ...this.spanUsage }, cost: { listCostCents: null, activeSeconds: 0 } };
    const id = this.sessionId;
    if (id !== null) {
      if (this.lastStatus !== "idle" && this.lastStatus !== "terminated" && inBudget()) {
        try {
          await port.sendEvents(id, [{ type: "user.interrupt" }], CLEANUP_CALL);
        } catch (e) {
          console.warn(`[agent] couldn't interrupt session ${id}: ${errorText(e)}`);
        }
      }
      const settled = await this.settledSession(id, inBudget);
      if (settled) spent = toAgentUsage(settled.usage);
      if (cfg.keepSessions) {
        console.warn(`[agent] AGENT_KEEP_SESSIONS=1: kept session ${id} and its uploads. Console path: /workspaces/<workspace>/sessions/${id}`);
      } else if (inBudget()) {
        try {
          await port.deleteSession(id, CLEANUP_CALL);
        } catch (e) {
          if (!(e instanceof NotFoundError)) console.warn(`[agent] couldn't delete session ${id}; the hourly sweep retries`);
        }
      }
      agentProcessSlot().active.delete(id);
    }
    if (!cfg.keepSessions) {
      for (const fileId of this.uploads) {
        if (!inBudget()) break;
        try {
          await port.deleteFile(fileId, CLEANUP_CALL);
        } catch (e) {
          if (!(e instanceof NotFoundError)) console.warn(`[agent] couldn't delete upload ${fileId}; it expires on its own`);
        }
      }
    }
    const cost = spent.cost.listCostCents === null ? "cost unknown" : `$${(spent.cost.listCostCents / 100).toFixed(2)}`;
    console.info(`[agent] ${this.spec.role}: session ${id ?? "(none)"} ${outcome} in ${Math.round(durationMs / 1000)} s, ${cost}`);
    return spent;
  }

  /** The session once it stopped running (a running session can't be deleted), or its last snapshot; null if unreadable. */
  private async settledSession(id: string, inBudget: () => boolean): Promise<RemoteSession | null> {
    let session: RemoteSession | null = null;
    for (let poll = 0; poll < CLEANUP_POLLS && inBudget(); poll++) {
      if (poll > 0) await this.sleep(CLEANUP_POLL_MS);
      try {
        session = await this.d.port.retrieveSession(id, CLEANUP_CALL);
      } catch (e) {
        console.warn(`[agent] couldn't read session ${id}: ${errorText(e)}`);
        return session;
      }
      if (session.status !== "running" && session.status !== "rescheduling") break;
    }
    return session;
  }

  private withBilled(error: AiError, spent: Spent): AiError {
    const { usage, cost } = spent;
    const billed = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0
      || (cost.listCostCents ?? 0) > 0 || cost.activeSeconds > 0;
    if (this.sessionId === null || !billed) return error;
    const servedModel = roleModel(this.d.cfg, this.spec.role);
    return new AiError(error.code, error.message, { ...error.o, billed: { servedModel, usage, agent: cost } });
  }
}

/** The stream or history fetch ended without an answer from the API: reconnect (§6.3 step 3). */
function isDroppedConnection(e: unknown): boolean {
  return e instanceof APIConnectionError || (e instanceof APIError && e.status === undefined);
}

/** "path.to.field: message", each cut to 200 characters, at most 20 lines. */
function zodProblems(issues: ReadonlyArray<{ readonly path: PropertyKey[]; readonly message: string }>): string[] {
  const lines = issues.slice(0, MAX_PROBLEM_LINES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return truncateChars(`${path}: ${issue.message}`, PROBLEM_MAX_CHARS);
  });
  if (issues.length > MAX_PROBLEM_LINES) lines.push(`…and ${issues.length - MAX_PROBLEM_LINES} more problems.`);
  return lines;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
