// Pure helpers behind the progress bars and running timers: formatting durations and turning the server's
// estimates into a bar position. No clocks in here, so every formula is tested with plain numbers.

/** How far an estimated bar (elapsed ÷ typical) may go before the work is actually done. */
export const ESTIMATE_CAP = 0.95;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** A running timer: 0 → "0:00", 83 000 → "1:23", 3 723 000 → "1:02:03". Whole seconds, rounded down; never negative. */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / SECOND);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "5 min", "1 h", "1 h 20 min" (whole minutes, at least 1). */
function minutesText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * What is left of an estimate: "about 3 min left", "less than a minute left", or "finishing up…" once the estimate has
 * run out (the work is late, not stuck: it ends when the server says so).
 */
export function formatTimeLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "finishing up…";
  if (ms < MINUTE) return "less than a minute left";
  return `about ${minutesText(ms)} left`;
}

/** A typical duration in words: "1 second", "45 seconds", "1 minute", "4 minutes", "1 h 20 min". */
export function formatApproxDuration(ms: number): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (safe < MINUTE - SECOND / 2) {
    const seconds = Math.max(1, Math.round(safe / SECOND));
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  if (safe < HOUR - MINUTE / 2) {
    const minutes = Math.max(1, Math.round(safe / MINUTE));
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return minutesText(safe);
}

/** "about 3 min left" → "About 3 min left". */
export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * An estimated bar position for one piece of work with no real progress to report: elapsed ÷ typical, held at `cap`
 * (95%) until the work is done, so the bar never claims to be finished while it is not.
 */
export function estimatedFraction(elapsedMs: number, typicalMs: number, cap = ESTIMATE_CAP): number {
  if (!(typicalMs > 0)) return 0;
  return Math.min(clamp01(cap), clamp01(elapsedMs / typicalMs));
}

/**
 * A grading batch's bar position: the papers done, plus partial credit for the papers being graded (each at
 * `inFlightElapsedMs` ÷ typical). The credit together stays below one whole paper (at most ESTIMATE_CAP of one), so the
 * bar never runs ahead of the next paper to finish and never steps back when it does.
 */
export function batchFraction(o: {
  done: number;
  total: number;
  grading: number;
  /** How long the papers being graded have been at it (a lower bound is fine: the credit stays conservative). */
  inFlightElapsedMs: number;
  typicalPaperMs: number;
}): number {
  if (!(o.total > 0)) return 0;
  const done = Math.min(o.total, Math.max(0, o.done));
  const inFlight = Math.max(0, Math.min(o.grading, o.total - done));
  const credit = inFlight === 0 ? 0 : Math.min(ESTIMATE_CAP, inFlight * estimatedFraction(o.inFlightElapsedMs, o.typicalPaperMs, 1));
  return clamp01((done + credit) / o.total);
}

/** The server's estimate (ms left when the page was rendered) minus the time since then; never below 0. */
export function remainingMs(etaMs: number, sinceRenderMs: number): number {
  return Math.max(0, Math.round(etaMs - Math.max(0, sinceRenderMs)));
}

/** Whole seconds until `untilMs` (rounded up), 0 once it has passed or for null. */
export function secondsUntil(untilMs: number | null, nowMs: number): number {
  if (untilMs === null) return 0;
  return Math.max(0, Math.ceil((untilMs - nowMs) / SECOND));
}
