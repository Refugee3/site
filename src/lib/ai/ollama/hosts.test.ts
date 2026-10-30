import { describe, expect, it } from "vitest";
import type { OllamaClient } from "./client";
import { createHostPool, HOST_DOWN_MS } from "./hosts";

const client = (baseUrl: string) => ({ baseUrl }) as OllamaClient;

describe("createHostPool", () => {
  it("fills each computer's slots in order, then makes callers wait for the first free one", async () => {
    const [a, b] = [client("http://a:11434"), client("http://b:11434")];
    const pool = createHostPool([a, b], 1);
    const first = await pool.acquire();
    const second = await pool.acquire();
    expect([first.client, second.client]).toEqual([a, b]);
    let third: OllamaClient | null = null;
    const waiting = pool.acquire().then((lease) => (third = lease.client));
    await Promise.resolve();
    expect(third).toBeNull();
    second.release();
    await waiting;
    expect(third).toBe(b);
  });

  it("skips a computer that was set aside, until it's been a while", async () => {
    let t = 0;
    const [a, b] = [client("http://a:11434"), client("http://b:11434")];
    const pool = createHostPool([a, b], 2, () => t);
    const lease = await pool.acquire();
    expect(pool.hasOther(lease)).toBe(true);
    lease.markDown();
    lease.release();
    expect((await pool.acquire()).client).toBe(b);
    expect((await pool.acquire()).client).toBe(b);
    t = HOST_DOWN_MS + 1;
    expect((await pool.acquire()).client).toBe(a);
  });

  it("tries every computer again when all were set aside, so the real error is reported", async () => {
    const [a, b] = [client("http://a:11434"), client("http://b:11434")];
    const pool = createHostPool([a, b], 1, () => 0);
    const la = await pool.acquire();
    la.markDown();
    la.release();
    const lb = await pool.acquire();
    expect(lb.client).toBe(b);
    expect(pool.hasOther(lb)).toBe(false);
    lb.markDown();
    lb.release();
    expect((await pool.acquire()).client).toBe(a);
  });

  it("stops waiting when the job is stopped", async () => {
    const pool = createHostPool([client("http://a:11434")], 1);
    await pool.acquire();
    const abort = new AbortController();
    const waiting = pool.acquire(abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
  });
});
