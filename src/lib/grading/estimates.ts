// Time estimates for the progress bars: pure, so the formulas are tested without a database.

/** How many recent durations an estimate looks at. */
export const ESTIMATE_SAMPLE_SIZE = 20;
/** Used until anything was measured on this server. */
export const FALLBACK_PAPER_MS = 60_000;
export const FALLBACK_EXTRACTION_MS = 45_000;
export const FALLBACK_SCAN_PAGE_MS = 2_000;

/** The median of `values` (the mean of the middle two for an even count); null for none. */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A typical duration in whole ms: the median of this assignment's recent durations, else of every assignment's, else
 * `fallbackMs`. Each list holds at most the last ESTIMATE_SAMPLE_SIZE durations, newest first.
 */
export function typicalMs(own: readonly number[], everywhere: readonly number[], fallbackMs: number): number {
  const m = median(own.slice(0, ESTIMATE_SAMPLE_SIZE)) ?? median(everywhere.slice(0, ESTIMATE_SAMPLE_SIZE)) ?? fallbackMs;
  return Math.max(1, Math.round(m));
}

/**
 * How long until a grading batch is done, in ms. A small simulation of the worker: `concurrency` slots; each paper being
 * graded holds a slot until max(0, typicalMs - its elapsed time); each queued paper then takes the slot that frees up first
 * for `typicalMs`. The ETA is when the last slot frees up. With nothing in flight this is ceil(queued / concurrency) ×
 * typicalMs; as time passes it only shrinks (in-flight papers that run long count as finishing now). The worker runs other
 * assignments' jobs too, so with several batches at once it is optimistic.
 */
export function estimateBatchEtaMs(o: {
  queued: number;
  /** Elapsed ms of each paper being graded now. */
  inFlightElapsedMs: readonly number[];
  concurrency: number;
  typicalMs: number;
}): number {
  const slots = Math.max(1, Math.floor(o.concurrency));
  const freeAt = o.inFlightElapsedMs.map((elapsed) => Math.max(0, o.typicalMs - Math.max(0, elapsed))).sort((a, b) => a - b);
  // More papers in flight than slots (the worker just lowered its concurrency): the extra ones still finish on their own.
  const pool = freeAt.length >= slots ? freeAt.slice(0, slots) : [...freeAt, ...new Array<number>(slots - freeAt.length).fill(0)];
  let last = freeAt.length > 0 ? freeAt[freeAt.length - 1] : 0;
  for (let i = 0; i < Math.max(0, o.queued); i++) {
    // The slot that frees up first takes the next paper.
    let min = 0;
    for (let j = 1; j < pool.length; j++) if (pool[j] < pool[min]) min = j;
    pool[min] += o.typicalMs;
    last = Math.max(last, pool[min]);
  }
  return Math.round(last);
}

/**
 * How long until a scan being split is read, in ms: its expected total (pages × typical ms per page, measured over whole
 * splits, so reading chunks in parallel is already in it) minus the time since the split was queued, never below 0.
 * Before the split starts (`elapsedMs` 0) it is the whole estimate. It reaches 0 while a slow split is still running.
 */
export function estimateSplitEtaMs(o: { pageCount: number; elapsedMs: number; perPageMs: number }): number {
  return Math.max(0, Math.round(o.pageCount * o.perPageMs - Math.max(0, o.elapsedMs)));
}
