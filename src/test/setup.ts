import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, vi } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { resetConfigForTests } from "@/lib/config";
import { setDbForTests } from "@/lib/db/connection";

// Only U1 modules are imported here; other units' singletons are reset by deleting their slots (§4).
const WORKER_SLOT = Symbol.for("pag.worker");
const RESETTABLE_SLOTS = [Symbol.for("pag.grader"), Symbol.for("pag.rate"), WORKER_SLOT];
const slots = globalThis as unknown as Record<symbol, unknown>;

vi.stubGlobal("fetch", async () => {
  throw new Error("network disabled in tests");
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pag-"));
process.env.AI_MODE = "fake";
process.env.ANTHROPIC_API_KEY = "";
process.env.DATA_DIR = dataDir;

afterEach(async () => {
  const worker = slots[WORKER_SLOT] as { stop?: () => Promise<void> } | undefined;
  await worker?.stop?.();
  for (const slot of RESETTABLE_SLOTS) delete slots[slot];
  setDbForTests(null);
  // A test that used getDb() directly left ${DATA_DIR}/app.db behind; the next test starts empty.
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dataDir, `app.db${suffix}`), { force: true });
  setClockForTests(null);
  vi.unstubAllEnvs();
  resetConfigForTests();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
