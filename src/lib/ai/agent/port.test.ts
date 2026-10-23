import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createSdkAgentPort } from "./port";
import { apiError } from "./test-fake";

// A structural stand-in for the SDK client: only the members the port uses, recording their arguments.

async function* pages<T>(...items: T[][]): AsyncGenerator<T> {
  for (const page of items) yield* page;
}

function fakeClient() {
  const controller = new AbortController();
  const streamed = [{ type: "session.status_running", id: "sevt_1" }, { type: "session.status_idle", id: "sevt_2" }];
  const session = (id: string, status = "idle") => ({
    id, status, created_at: "2026-10-07T10:00:00Z", usage: { input_tokens: 5 }, agent: {}, archived_at: null,
  });
  const client = {
    beta: {
      environments: {
        create: vi.fn(async (p: { name: string }) => ({ id: "env_1", name: p.name, archived_at: null, config: {} })),
        retrieve: vi.fn(async (id: string) => ({ id, name: "pdf-autograder-x", archived_at: "2026-10-01T00:00:00Z" })),
        update: vi.fn(async (id: string) => ({ id, name: "pdf-autograder-x", archived_at: null })),
        list: vi.fn(() => pages(
          [{ id: "env_a", name: "other", archived_at: null }, { id: "env_b", name: "pdf-autograder-x", archived_at: "2026-10-01T00:00:00Z" }],
          [{ id: "env_c", name: "pdf-autograder-x", archived_at: null }],
        )),
      },
      agents: {
        create: vi.fn(async () => ({ id: "agent_1", version: 1, archived_at: null, name: "n" })),
        retrieve: vi.fn(async (id: string) => ({ id, version: 4, archived_at: null })),
        update: vi.fn(async (id: string) => ({ id, version: 5, archived_at: null })),
      },
      sessions: {
        create: vi.fn(async () => session("sesn_1", "running")),
        retrieve: vi.fn(async (id: string) => session(id)),
        delete: vi.fn(async (id: string) => ({ id, type: "session_deleted" })),
        list: vi.fn(() => pages([session("sesn_a")], [session("sesn_b", "running")])),
        events: {
          stream: vi.fn(async () => ({
            controller,
            async *[Symbol.asyncIterator]() {
              yield* streamed;
            },
          })),
          list: vi.fn(() => pages([{ id: "sevt_1", type: "user.message" }], [{ id: "sevt_2", type: "agent.message" }])),
          send: vi.fn(async () => ({ data: [] })),
        },
      },
    },
    files: {
      upload: vi.fn(async () => ({ id: "file_1", type: "file" })),
      delete: vi.fn(async (id: string) => ({ id, type: "file_deleted" })),
    },
  };
  return { client, controller, port: createSdkAgentPort(client as unknown as Anthropic) };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("createSdkAgentPort", () => {
  it("uploads a File with the given name, the PDF type and the expiry, via the stable Files API", async () => {
    const { client, port } = fakeClient();
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);
    await expect(port.uploadPdf("student-submission.pdf", bytes, 3600, { timeoutMs: 120_000 })).resolves.toEqual({ id: "file_1" });
    const [params, options] = client.files.upload.mock.calls[0] as unknown as [{ file: File; expires_in_seconds: number }, unknown];
    expect(params.file).toBeInstanceOf(File);
    expect(params.file.name).toBe("student-submission.pdf");
    expect(params.file.type).toBe("application/pdf");
    expect(new Uint8Array(await params.file.arrayBuffer())).toEqual(bytes);
    expect(params.expires_in_seconds).toBe(3600);
    expect(options).toEqual({ timeout: 120_000 });
  });

  it("forwards signal and timeout, and leaves them out when not given", async () => {
    const { client, port } = fakeClient();
    const signal = new AbortController().signal;
    await port.createEnvironment({ name: "pdf-autograder-x" }, { signal, timeoutMs: 30_000 });
    expect(client.beta.environments.create).toHaveBeenCalledWith({ name: "pdf-autograder-x" }, { signal, timeout: 30_000 });
    await port.retrieveAgent("agent_1");
    expect(client.beta.agents.retrieve).toHaveBeenCalledWith("agent_1", {}, {});
    await port.sendEvents("sesn_1", [{ type: "user.interrupt" }], { timeoutMs: 10_000 });
    expect(client.beta.sessions.events.send).toHaveBeenCalledWith("sesn_1", { events: [{ type: "user.interrupt" }] }, { timeout: 10_000 });
    await port.deleteFile("file_1", { timeoutMs: 10_000 });
    expect(client.files.delete).toHaveBeenCalledWith("file_1", {}, { timeout: 10_000 });
    await port.deleteSession("sesn_1");
    expect(client.beta.sessions.delete).toHaveBeenCalledWith("sesn_1", {}, {});
  });

  it("renames the fields the engine reads", async () => {
    const { port } = fakeClient();
    await expect(port.retrieveEnvironment("env_1")).resolves.toEqual({ id: "env_1", name: "pdf-autograder-x", archivedAt: "2026-10-01T00:00:00Z" });
    await expect(port.updateAgent("agent_1", { version: 4 })).resolves.toEqual({ id: "agent_1", version: 5, archivedAt: null });
    await expect(port.createAgent({ name: "n", model: "claude-opus-5-5" })).resolves.toEqual({ id: "agent_1", version: 1, archivedAt: null });
    await expect(port.createSession({ agent: "agent_1", environment_id: "env_1" })).resolves.toEqual({
      id: "sesn_1", status: "running", usage: { input_tokens: 5 }, createdAt: "2026-10-07T10:00:00Z",
    });
  });

  it("finds the first non-archived environment with the exact name across pages", async () => {
    const { port } = fakeClient();
    await expect(port.findEnvironmentByName("pdf-autograder-x")).resolves.toEqual({ id: "env_c", name: "pdf-autograder-x", archivedAt: null });
    await expect(port.findEnvironmentByName("missing")).resolves.toBeNull();
  });

  it("walks every page of sessions (filtered by agent and age) and events", async () => {
    const { client, port } = fakeClient();
    const sessions = await collect(port.listSessions({ agentId: "agent_1", createdBefore: "2026-10-07T09:00:00.000Z" }, { timeoutMs: 30_000 }));
    expect(sessions.map((s) => [s.id, s.status])).toEqual([["sesn_a", "idle"], ["sesn_b", "running"]]);
    expect(client.beta.sessions.list)
      .toHaveBeenCalledWith({ agent_id: "agent_1", "created_at[lt]": "2026-10-07T09:00:00.000Z" }, { timeout: 30_000 });
    const signal = new AbortController().signal;
    const listed = await collect(port.listEvents("sesn_1", { signal, timeoutMs: 30_000 }));
    expect(listed.map((e) => e.id)).toEqual(["sevt_1", "sevt_2"]);
    expect(client.beta.sessions.events.list).toHaveBeenCalledWith("sesn_1", {}, { signal, timeout: 30_000 });
  });

  it("opens the event stream with the caller's signal and aborts its controller on close()", async () => {
    const { client, controller, port } = fakeClient();
    const signal = new AbortController().signal;
    const stream = await port.streamEvents("sesn_1", { signal });
    expect(client.beta.sessions.events.stream).toHaveBeenCalledWith("sesn_1", {}, { signal });
    expect((await collect(stream)).map((e) => e.type)).toEqual(["session.status_running", "session.status_idle"]);
    expect(controller.signal.aborted).toBe(false);
    stream.close();
    expect(controller.signal.aborted).toBe(true);
  });

  it("lets SDK errors through unchanged", async () => {
    const { client, port } = fakeClient();
    const conflict = apiError(409);
    client.beta.environments.create.mockRejectedValueOnce(conflict);
    await expect(port.createEnvironment({ name: "x" })).rejects.toBe(conflict);
    const gone = apiError(404);
    client.beta.sessions.events.send.mockRejectedValueOnce(gone);
    await expect(port.sendEvents("sesn_1", [{ type: "user.interrupt" }])).rejects.toBe(gone);
    const failing = apiError(500);
    client.beta.sessions.list.mockImplementationOnce(() => (async function* () {
      yield* [];
      throw failing;
    })());
    await expect(collect(port.listSessions({ agentId: "a", createdBefore: "x" }))).rejects.toBe(failing);
  });
});
