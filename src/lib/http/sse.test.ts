import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveEventStream, sseEvent, type LiveStreamOptions } from "@/lib/http/sse";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Reads everything the stream has produced so far (without waiting for more). */
function collector(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return;
      }
      text += decoder.decode(chunk.value);
    }
  })();
  return {
    get text() {
      return text;
    },
    get done() {
      return done;
    },
    events: (name: string) => text.split("\n\n").filter((block) => block.startsWith(`event: ${name}\n`))
      .map((block) => JSON.parse(block.slice(block.indexOf("data: ") + 6)) as unknown),
    cancel: () => reader.cancel(),
  };
}

function options(o: Partial<LiveStreamOptions<{ n: number }>> & { state: { n: number; probe: string } }): LiveStreamOptions<{ n: number }> {
  const { state, ...rest } = o;
  return {
    signal: new AbortController().signal,
    probe: () => state.probe,
    build: () => ({ n: state.n }),
    signature: (s) => String(s.n),
    ...rest,
  };
}

describe("liveEventStream", () => {
  it("sends the retry delay and a first snapshot at once, then only snapshots that changed", async () => {
    const state = { n: 1, probe: "a" };
    const build = vi.fn(() => ({ n: state.n }));
    const out = collector(liveEventStream(options({ state, build })));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.text.startsWith("retry: 3000\n\n")).toBe(true);
    expect(out.events("snapshot")).toEqual([{ n: 1 }]);

    // Same probe: not even rebuilt.
    await vi.advanceTimersByTimeAsync(3000);
    expect(build).toHaveBeenCalledTimes(1);

    // The probe changed but the snapshot did not: rebuilt, not sent.
    state.probe = "b";
    await vi.advanceTimersByTimeAsync(1000);
    expect(build).toHaveBeenCalledTimes(2);
    expect(out.events("snapshot")).toEqual([{ n: 1 }]);

    state.probe = "c";
    state.n = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(out.events("snapshot")).toEqual([{ n: 1 }, { n: 2 }]);
    void out.cancel();
  });

  it("rebuilds now and then without a probe change, and sends heartbeats while quiet", async () => {
    const state = { n: 1, probe: "a" };
    const out = collector(liveEventStream(options({ state, rebuildMs: 5000, heartbeatMs: 15_000 })));
    await vi.advanceTimersByTimeAsync(0);
    state.n = 2; // e.g. the worker paused: nothing in the database changed
    await vi.advanceTimersByTimeAsync(4000);
    expect(out.events("snapshot")).toEqual([{ n: 1 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(out.events("snapshot")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(out.text).not.toContain(": keep-alive");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(out.text).toContain(": keep-alive\n\n");
    void out.cancel();
  });

  it("stops polling when the request is aborted", async () => {
    const state = { n: 1, probe: "a" };
    const controller = new AbortController();
    const probe = vi.fn(() => state.probe);
    const out = collector(liveEventStream(options({ state, probe, signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(2000);
    const calls = probe.mock.calls.length;
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(calls);
    expect(out.done).toBe(true);
  });

  it("stops polling when the reader cancels", async () => {
    const state = { n: 1, probe: "a" };
    const probe = vi.fn(() => state.probe);
    const out = collector(liveEventStream(options({ state, probe })));
    await vi.advanceTimersByTimeAsync(1000);
    await out.cancel();
    const calls = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(calls);
  });

  it("says when the subject is gone or the session ended, and ends", async () => {
    const gone = collector(liveEventStream(options({ state: { n: 1, probe: "a" }, build: () => null })));
    await vi.advanceTimersByTimeAsync(0);
    expect(gone.events("gone")).toEqual([{ reason: "not_found" }]);
    expect(gone.done).toBe(true);

    let allowed = true;
    const loggedOut = collector(liveEventStream(options({ state: { n: 1, probe: "a" }, stillAllowed: () => allowed, authCheckMs: 2000 })));
    await vi.advanceTimersByTimeAsync(1000);
    allowed = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(loggedOut.events("gone")).toEqual([{ reason: "unauthorized" }]);
    expect(loggedOut.done).toBe(true);
  });

  it("ends after its maximum lifetime and on an error", async () => {
    const out = collector(liveEventStream(options({ state: { n: 1, probe: "a" }, maxMs: 5000 })));
    await vi.advanceTimersByTimeAsync(6000);
    expect(out.done).toBe(true);

    const onError = vi.fn();
    const failing = collector(liveEventStream(options({ state: { n: 1, probe: "a" }, probe: () => { throw new Error("db"); }, onError })));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(failing.done).toBe(true);
  });

  it("formats events as SSE", () => {
    expect(sseEvent("snapshot", { a: 1 })).toBe('event: snapshot\ndata: {"a":1}\n\n');
  });
});
