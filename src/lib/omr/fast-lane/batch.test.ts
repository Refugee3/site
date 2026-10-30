import { describe, expect, it } from "vitest";
import type { TranscribeInput } from "@/lib/ai/grader";
import { AiError } from "@/lib/ai/errors";
import { buildTranscribeParams } from "@/lib/ai/claude";
import { nameHintsFor, transcribeTask } from "@/lib/ai/spot-prompts";
import { FAKE_META } from "@/lib/jobs/test-utils";
import { type Crop, planBatches, transcribeInBatches } from "./batch";

const crop = (id: string, kind: Crop["kind"] = "write_in"): Crop => ({ id, kind, png: new Uint8Array([1, 2, 3]), width: 10, height: 5 });

/** A transcriber that answers each crop with its id reversed, after `delayMs`, and records its calls and concurrency. */
function transcriber(o: { delayMs?: number; failOn?: string; drop?: string } = {}) {
  const calls: TranscribeInput[] = [];
  let running = 0;
  let maxRunning = 0;
  return {
    calls,
    maxRunning: () => maxRunning,
    g: {
      async transcribeCrops(input: TranscribeInput) {
        calls.push(input);
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, o.delayMs ?? 5));
        running--;
        if (input.crops.some((c) => c.id === o.failOn)) throw new AiError("server_error", "Ollama failed", { retryable: true });
        return {
          output: {
            crops: input.crops.filter((c) => c.id !== o.drop).map((c) => ({ id: c.id.toLowerCase(), text: [...c.id].reverse().join(""), confidence: "high" as const })),
          },
          meta: { ...FAKE_META, usage: { ...FAKE_META.usage, inputTokens: 10 }, durationMs: o.delayMs ?? 5 },
        };
      },
    },
  };
}

describe("batching a class's crops", () => {
  it("puts name and class crops in batches of their own, first, and answers after, at most `size` a batch", () => {
    const crops = [crop("P1-NAME", "name"), crop("P1-Q1"), crop("P1-Q2"), crop("P2-NAME", "name"), crop("P2-SECTION", "section"), crop("P2-Q1")];
    const batches = planBatches(crops, 2);
    expect(batches.map((b) => [b.identity, b.crops.map((c) => c.id)])).toEqual([
      [true, ["P1-NAME", "P2-NAME"]], [true, ["P2-SECTION"]], [false, ["P1-Q1", "P1-Q2"]], [false, ["P2-Q1"]],
    ]);
    expect(planBatches([], 8)).toEqual([]);
    // A pixel budget per call: a large crop closes the batch early, and a crop larger than the budget goes alone.
    const big = { ...crop("P1-Q9"), width: 2000, height: 1000 };
    expect(planBatches([crop("P1-Q1"), crop("P1-Q2"), big, crop("P1-Q3")], 8, 1_000_000).map((b) => b.crops.map((c) => c.id)))
      .toEqual([["P1-Q1", "P1-Q2"], ["P1-Q9"], ["P1-Q3"]]);
    expect(planBatches(crops, 0).length).toBe(crops.length);
  });

  it("transcribes ceil(n / 8) batches, up to `concurrency` at once, and maps every text back by crop id", async () => {
    const t = transcriber({ delayMs: 20 });
    const crops = [crop("P1-NAME", "name"), crop("P2-NAME", "name"), ...Array.from({ length: 19 }, (_, i) => crop(`P${(i % 3) + 1}-Q${i + 1}`))];
    const progress: number[] = [];
    const result = await transcribeInBatches(t.g, crops, {
      size: 8, concurrency: 2, nameHints: ["Maria Lopez", "Wei Chen"], onBatch: (done) => progress.push(done),
    });
    expect(t.calls).toHaveLength(1 + Math.ceil(19 / 8));
    expect(result.calls).toBe(4);
    expect(t.maxRunning()).toBe(2);
    expect(progress.at(-1)).toBe(crops.length);
    // Ids come back as sent (the model's spelling of an id doesn't matter).
    expect(result.texts.get("P1-NAME")).toEqual({ id: "P1-NAME", text: "EMAN-1P", confidence: "high" });
    expect(result.texts.get("P3-Q3")?.text).toBe("3Q-3P");
    expect(result.texts.size).toBe(crops.length);
    expect(result.meta?.usage.inputTokens).toBe(40);
    // The class list goes only with the name crops; crops carry nothing but their image and id.
    expect(t.calls.filter((c) => c.nameHints !== undefined).map((c) => c.crops.map((x) => x.kind))).toEqual([["name", "name"]]);
    for (const call of t.calls) for (const c of call.crops) expect(Object.keys(c).sort()).toEqual(["height", "id", "kind", "png", "width"]);
  });

  it("a crop the AI left out is absent; a failed call rejects with the cost of the calls before it", async () => {
    const dropped = await transcribeInBatches(transcriber({ drop: "P1-Q2" }).g, [crop("P1-Q1"), crop("P1-Q2")], { size: 8, concurrency: 1 });
    expect([...dropped.texts.keys()]).toEqual(["P1-Q1"]);

    const crops = Array.from({ length: 16 }, (_, i) => crop(`P1-Q${i + 1}`));
    const err = await transcribeInBatches(transcriber({ failOn: "P1-Q12" }).g, crops, { size: 8, concurrency: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).o.billed?.usage.inputTokens).toBe(10);
    expect(await transcribeInBatches(transcriber().g, [], { size: 8, concurrency: 2 })).toMatchObject({ calls: 0, meta: null });
  });
});

describe("the class list as hints for name crops only", () => {
  it("is in the task text only when given, and only for a call with a name crop", () => {
    expect(transcribeTask(["Q1"])).not.toMatch(/students in this class/);
    expect(transcribeTask(["P1-NAME"], { nameHints: ["Maria Lopez", "Wei Chen"] })).toMatch(/students in this class[\s\S]*Maria Lopez; Wei Chen/);
    expect(nameHintsFor([{ kind: "write_in" }], ["Maria Lopez"])).toBeUndefined();
    expect(nameHintsFor([{ kind: "section" }], ["Maria Lopez"])).toBeUndefined();
    expect(nameHintsFor([{ kind: "name" }], ["Maria Lopez"])).toEqual(["Maria Lopez"]);
    expect(nameHintsFor([{ kind: "name" }], [])).toBeUndefined();
  });

  it("never reaches the Claude request of answer crops, even when set by mistake", () => {
    const cfg = { effort: "low" as const, fallbacks: false, cacheTtl: "5m" as const, maxTokens: 8000, model: "claude-sonnet-5-5" as const };
    const answers = JSON.stringify(buildTranscribeParams({ crops: [crop("Q1")], nameHints: ["Maria Lopez"] }, cfg));
    expect(answers).not.toContain("Maria Lopez");
    const names = JSON.stringify(buildTranscribeParams({ crops: [crop("NAME", "name")], nameHints: ["Maria Lopez"] }, cfg));
    expect(names).toContain("Maria Lopez");
    expect(names).toContain("the student's name");
  });
});
