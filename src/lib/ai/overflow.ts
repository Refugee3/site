import { now } from "@/lib/clock";
import { estimateCostUsd } from "@/lib/pricing";
import type { AiCallMeta, CallOptions, Grader } from "./grader";
import type { OllamaGrader } from "./ollama/grader";

// The Claude overflow: Ollama grades as usual, but when every local slot is busy and more papers are waiting than the
// teacher's limit, the next call goes to Claude instead of waiting, as long as this month's overflow spend is under the cap.
// Each call is routed on its own (a paper may be read by Claude and judged locally). A Claude failure (no credit, a bad key,
// an outage) never stops local grading: the call is done locally and the overflow rests for a while.

/** Extra papers the worker runs at once while the overflow is on, so there are papers to send to Claude. */
export const OVERFLOW_EXTRA_PAPERS = 4;
/** After a Claude failure, the overflow isn't used for this long. */
export const OVERFLOW_REST_MS = 10 * 60_000;

export interface OverflowPolicy {
  /** Whether a call may go to Claude now (enough papers waiting, spend under the cap). */
  allowed(): boolean;
  /** Records a call Claude answered: its estimated cost, and whether it was a paper's reading (counted as one paper). */
  spent(costUsd: number, paper: boolean): void;
}

type Method = "extractKey" | "readSubmission" | "judgeSubmission" | "gradeSubmission" | "readScanPages" | "readPacketChunk"
  | "gradePacketChunk" | "transcribeCrops" | "proposeSpots";

/** The calls that read a whole paper (counted as papers in the overflow's monthly total). */
const PAPER_CALLS = new Set<Method>(["readSubmission", "gradeSubmission"]);

export function createOverflowGrader(o: { local: OllamaGrader; claude: () => Grader | null; policy: OverflowPolicy }): Grader {
  let restingUntil = 0;

  function route(): Grader | null {
    if (o.local.freeSlots() > 0 || now() < restingUntil) return null;
    if (!o.policy.allowed()) return null;
    return o.claude();
  }

  /** Runs `method` on Claude when the overflow takes it, else (or after a Claude failure) on the local grader. */
  async function call<A, R extends { meta: AiCallMeta }>(method: Method, input: A, opts: CallOptions | undefined): Promise<R> {
    type Fn = (i: A, c?: CallOptions) => Promise<R>;
    const localFn = (o.local as unknown as Record<Method, Fn | undefined>)[method]!.bind(o.local);
    const claude = route();
    const claudeFn = claude ? (claude as unknown as Record<Method, Fn | undefined>)[method]?.bind(claude) : undefined;
    if (!claudeFn) return localFn(input, opts);
    try {
      const result = await claudeFn(input, opts);
      o.policy.spent(estimateCostUsd(result.meta.usage, result.meta.servedModel, "5m") ?? 0, PAPER_CALLS.has(method));
      return result;
    } catch (e) {
      if (opts?.signal?.aborted) throw e;
      restingUntil = now() + OVERFLOW_REST_MS;
      console.warn(`[overflow] Claude couldn't take a ${method} call (${e instanceof Error ? e.message : String(e)}); grading locally.`);
      return localFn(input, opts);
    }
  }

  const local = o.local;
  return {
    mode: local.mode,
    engine: local.engine,
    parallel: (local.parallel ?? 1) + OVERFLOW_EXTRA_PAPERS,
    cropsPerCall: local.cropsPerCall,
    extractKey: (i, c) => call("extractKey", i, c),
    readSubmission: (i, c) => call("readSubmission", i, c),
    judgeSubmission: (i, c) => call("judgeSubmission", i, c),
    gradeSubmission: (i, c) => call("gradeSubmission", i, c),
    readScanPages: (i, c) => call("readScanPages", i, c),
    ...(local.readPacketChunk ? { readPacketChunk: (i, c) => call("readPacketChunk", i, c) } : {}),
    ...(local.gradePacketChunk ? { gradePacketChunk: (i, c) => call("gradePacketChunk", i, c) } : {}),
    ...(local.transcribeCrops ? { transcribeCrops: (i, c) => call("transcribeCrops", i, c) } : {}),
    ...(local.proposeSpots ? { proposeSpots: (i, c) => call("proposeSpots", i, c) } : {}),
  } satisfies Grader;
}
