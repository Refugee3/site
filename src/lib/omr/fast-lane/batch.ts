import type { AiCallMeta, CallOptions, Grader, TranscribeInput } from "@/lib/ai/grader";
import type { CropTranscriptions } from "@/lib/ai/schemas";
import { combineMeta, withEarlierCost } from "@/lib/ai/read-then-mark";
import { isIdentityKind } from "../types";

// Reading a whole class's crops at once (the fast lane): every written answer and every name of every paper in the scan is
// a crop with an id unique in the scan; they are sent to transcribeCrops in batches (Ollama: a few per call; Claude: many),
// up to `concurrency` batches at a time, and each transcription is mapped back by its crop's id. Name and class crops go in
// batches of their own, the only ones the class list is sent with. A crop carries no question and no answer.

export type Crop = TranscribeInput["crops"][number];

/** Crops per call for an engine that doesn't say (the practice grader). */
export const DEFAULT_CROPS_PER_CALL = 8;

export interface CropBatch {
  crops: Crop[];
  /** Name and class crops: the class list may be sent with them. */
  identity: boolean;
}

/**
 * The crops in batches of at most `size` (and at most `maxPixels` of images, so a local model's context holds them, though a
 * crop larger than that still goes, alone): identity crops first, in batches of their own; answers after. Order is kept.
 */
export function planBatches(crops: Crop[], size: number, maxPixels = Infinity): CropBatch[] {
  const n = Math.max(1, Math.floor(size));
  const batches: CropBatch[] = [];
  const add = (list: Crop[], identity: boolean) => {
    let current: Crop[] = [];
    let pixels = 0;
    for (const c of list) {
      const p = c.width * c.height;
      if (current.length > 0 && (current.length >= n || pixels + p > maxPixels)) {
        batches.push({ crops: current, identity });
        current = [];
        pixels = 0;
      }
      current.push(c);
      pixels += p;
    }
    if (current.length > 0) batches.push({ crops: current, identity });
  };
  add(crops.filter((c) => isIdentityKind(c.kind)), true);
  add(crops.filter((c) => !isIdentityKind(c.kind)), false);
  return batches;
}

export interface Transcribed {
  /** By crop id (as sent); a crop the AI left out is absent. */
  texts: Map<string, CropTranscriptions["crops"][number]>;
  /** The calls' usage and models combined; null when there was nothing to read. */
  meta: AiCallMeta | null;
  calls: number;
  /** Wall-clock time of all the calls (they overlap). */
  wallMs: number;
}

/**
 * Transcribes every crop: in batches of `size`, up to `concurrency` calls at once. `onBatch` reports the crops read so far.
 * A failed call stops the others from starting and rejects (with the cost of the calls that succeeded).
 */
export async function transcribeInBatches(
  g: Pick<Grader, "transcribeCrops">, crops: Crop[],
  o: {
    size: number; concurrency: number; nameHints?: string[]; signal?: AbortSignal;
    /** Most image pixels in one call (planBatches). */
    maxPixels?: number;
    /** After each batch: the crops read so far. */
    onBatch?: (done: number, total: number) => void;
    /** Each successful call (to record its usage). */
    onCall?: (meta: AiCallMeta) => void;
  },
): Promise<Transcribed> {
  const startedAt = performance.now();
  const texts = new Map<string, CropTranscriptions["crops"][number]>();
  if (crops.length === 0 || !g.transcribeCrops) return { texts, meta: null, calls: 0, wallMs: 0 };
  const transcribe = g.transcribeCrops.bind(g);
  const batches = planBatches(crops, o.size, o.maxPixels);
  const metas: AiCallMeta[] = [];
  let failure: { error: unknown } | null = null;
  let next = 0;
  let done = 0;
  const call: CallOptions = { signal: o.signal };
  const worker = async () => {
    while (failure === null && next < batches.length) {
      const batch = batches[next++];
      const hints = batch.identity && o.nameHints && o.nameHints.length > 0 ? { nameHints: o.nameHints } : {};
      try {
        const result = await transcribe({ crops: batch.crops, ...hints }, call);
        metas.push(result.meta);
        o.onCall?.(result.meta);
        const sent = new Map(batch.crops.map((c) => [normalizeId(c.id), c.id]));
        for (const t of result.output.crops) {
          const id = sent.get(normalizeId(t.id));
          if (id !== undefined && !texts.has(id)) texts.set(id, { ...t, id });
        }
        done += batch.crops.length;
        o.onBatch?.(done, crops.length);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(o.concurrency), batches.length)) }, worker));
  const meta = metas.length === 0 ? null : metas.slice(1).reduce(combineMeta, metas[0]);
  if (failure !== null) {
    const error = (failure as { error: unknown }).error;
    throw meta ? withEarlierCost(error, meta) : error;
  }
  return { texts, meta, calls: metas.length, wallMs: Math.round(performance.now() - startedAt) };
}

function normalizeId(id: string): string {
  return id.replace(/[[\]]/g, "").trim().toUpperCase();
}
