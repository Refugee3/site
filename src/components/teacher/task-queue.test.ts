import { describe, expect, it } from "vitest";
import { createTaskQueue } from "./task-queue";

/** A task whose completion the test controls. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createTaskQueue", () => {
  it("runs at most `limit` tasks at once, in push order", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const queue = createTaskQueue<string>(2, async (name) => {
      started.push(name);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const gate = deferred();
      gates.set(name, gate);
      await gate.promise;
      running -= 1;
    });

    queue.push("a", "b", "c", "d");
    expect(started).toEqual(["a", "b"]);

    gates.get("b")!.resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);

    queue.push("e");
    gates.get("a")!.resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c", "d"]);

    gates.get("c")!.resolve();
    gates.get("d")!.resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    gates.get("e")!.resolve();
    await flush();
    expect(maxRunning).toBe(2);
    expect(running).toBe(0);
  });

  it("starts tasks pushed after the queue went idle", async () => {
    const done: number[] = [];
    const queue = createTaskQueue<number>(2, async (n) => {
      done.push(n);
    });
    queue.push(1);
    await flush();
    queue.push(2, 3);
    await flush();
    expect(done).toEqual([1, 2, 3]);
  });
});
