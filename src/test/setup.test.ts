import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { now, setClockForTests } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/connection";
import { countTeachers, insertTeacher } from "@/lib/db/repos/teachers";

const slots = globalThis as unknown as Record<symbol, unknown>;
// A plain counter: vitest 5 defaults to clearMocks, which would wipe a vi.fn() history between tests.
let workerStops = 0;

// These tests run in order: each "leaves" test dirties shared state that the next one checks was reset.
describe("test setup", () => {
  it("disables the network", async () => {
    await expect(fetch("https://api.anthropic.com")).rejects.toThrow("network disabled in tests");
  });

  it("runs in fake AI mode without an API key or APP_SECRET, in a temporary data directory", () => {
    const cfg = getConfig();
    expect(cfg.aiMode).toBe("fake");
    expect(cfg.hasApiKey).toBe(false);
    expect(cfg.appSecret).toBeNull();
    expect(cfg.dataDir.startsWith(os.tmpdir())).toBe(true);
  });

  it("leaves a file database, a secret key file, a pinned clock, stubbed env and singleton slots behind", () => {
    vi.stubEnv("MAX_PAGES", "7");
    expect(getConfig().maxPages).toBe(7);
    insertTeacher({ email: "a@school.org", displayName: "A", passwordHash: "h" });
    fs.writeFileSync(path.join(getConfig().dataDir, "secret.key"), Buffer.alloc(32));
    setClockForTests(() => 5);
    slots[Symbol.for("pag.grader")] = { grader: null };
    slots[Symbol.for("pag.rate")] = new Map();
    slots[Symbol.for("pag.worker")] = {
      stop: async () => {
        workerStops += 1;
      },
    };
  });

  it("starts the next test from a clean slate", () => {
    expect(workerStops).toBe(1);
    for (const name of ["pag.grader", "pag.rate", "pag.worker"]) expect(slots[Symbol.for(name)]).toBeUndefined();
    expect(now()).not.toBe(5);
    expect(getConfig().maxPages).toBe(40);
    expect(getDb().name.endsWith("app.db")).toBe(true);
    expect(countTeachers()).toBe(0);
    expect(fs.existsSync(path.join(getConfig().dataDir, "secret.key"))).toBe(false);
  });
});
