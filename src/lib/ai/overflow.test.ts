import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { addOverflowSpend, getOverflowSpend, monthKey, setOverflowSettings } from "@/lib/db/repos/capacity";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import { AiError } from "./errors";
import { createFakeGrader } from "./fake";
import type { AiCallMeta, Grader } from "./grader";
import { overflowPolicy } from "./index";
import type { OllamaGrader } from "./ollama/grader";
import { createOverflowGrader, OVERFLOW_EXTRA_PAPERS, OVERFLOW_REST_MS, type OverflowPolicy } from "./overflow";

const T0 = Date.UTC(2026, 9, 15, 12);
const input = { assignmentTitle: "Quiz", teacherNotes: "", keyPdf: new Uint8Array([1]), pageCount: 1 };

/** A grader that answers extractKey with its name as the served model. */
function named(served: string, o: { fail?: boolean } = {}): Grader {
  const fake = createFakeGrader({ delayMs: 0 });
  return {
    ...fake,
    async extractKey(i, c) {
      if (o.fail) throw new AiError("auth", "invalid x-api-key", { retryable: false, pauseWorker: true });
      const result = await fake.extractKey(i, c);
      const meta: AiCallMeta = { ...result.meta, servedModel: served, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      return { ...result, meta };
    },
  };
}

function setUp(o: { free: number; allowed: boolean; claudeFails?: boolean }) {
  let free = o.free;
  const local: OllamaGrader = { ...named("ollama:qwen3.6:27b"), engine: "ollama", parallel: 3, freeSlots: () => free };
  const spent: Array<[number, boolean]> = [];
  const policy: OverflowPolicy = { allowed: () => o.allowed, spent: (cost, paper) => spent.push([cost, paper]) };
  const grader = createOverflowGrader({ local, claude: () => named("claude-sonnet-5-5", { fail: o.claudeFails }), policy });
  return { grader, spent, setFree: (n: number) => (free = n) };
}

describe("createOverflowGrader", () => {
  beforeEach(() => setClockForTests(() => T0));

  it("runs more papers at once so there are some to send to Claude", () => {
    expect(setUp({ free: 1, allowed: true }).grader.parallel).toBe(3 + OVERFLOW_EXTRA_PAPERS);
  });

  it("grades locally while a local slot is free, or while the overflow isn't allowed", async () => {
    expect((await setUp({ free: 1, allowed: true }).grader.extractKey(input)).meta.servedModel).toBe("ollama:qwen3.6:27b");
    expect((await setUp({ free: 0, allowed: false }).grader.extractKey(input)).meta.servedModel).toBe("ollama:qwen3.6:27b");
  });

  it("sends the call to Claude when every local slot is busy and the overflow is allowed, and records the cost", async () => {
    const { grader, spent } = setUp({ free: 0, allowed: true });
    expect((await grader.extractKey(input)).meta.servedModel).toBe("claude-sonnet-5-5");
    // 1M input tokens of Sonnet 5.5 at $2 per million.
    expect(spent).toEqual([[2, false]]);
  });

  it("grades locally when Claude fails, and rests the overflow for a while", async () => {
    const { grader, spent } = setUp({ free: 0, allowed: true, claudeFails: true });
    expect((await grader.extractKey(input)).meta.servedModel).toBe("ollama:qwen3.6:27b");
    expect(spent).toEqual([]);
    setClockForTests(() => T0 + OVERFLOW_REST_MS - 1);
    expect((await grader.extractKey(input)).meta.servedModel).toBe("ollama:qwen3.6:27b");
  });
});

describe("overflowPolicy", () => {
  beforeEach(() => {
    useTestDb();
    setClockForTests(() => T0);
  });

  let batch = 0;
  function waiting(n: number): void {
    const a = seedAssignment(seedTeacher().id);
    batch++;
    for (let i = 0; i < n; i++) enqueueJob({ kind: "grade_submission", targetId: `b${batch}-s${i}`, assignmentId: a.id, priority: 20, maxAttempts: 4 });
  }

  it("is off until turned on", () => {
    waiting(50);
    expect(overflowPolicy().allowed()).toBe(false);
  });

  it("allows Claude once more papers wait than the setting, until the month's cap is spent", () => {
    setOverflowSettings({ enabled: true, afterPapers: 5, monthlyCapUsd: 10 });
    waiting(5);
    expect(overflowPolicy().allowed()).toBe(false);
    waiting(1);
    expect(overflowPolicy().allowed()).toBe(true);
    overflowPolicy().spent(9.5, true);
    expect(getOverflowSpend(monthKey(T0))).toEqual({ microUsd: 9_500_000, papers: 1 });
    expect(overflowPolicy().allowed()).toBe(true);
    addOverflowSpend(monthKey(T0), 500_000, 0);
    expect(overflowPolicy().allowed()).toBe(false);
    // A new month starts again from nothing.
    setClockForTests(() => Date.UTC(2026, 10, 15, 12));
    expect(overflowPolicy().allowed()).toBe(true);
  });
});
