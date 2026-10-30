import type { Confidence, ItemReviewReason } from "@/lib/types";

// Reading marks from added-ink scores (pure). The thresholds are fractions of a spot's area at OMR_DPI: a circle around an
// option letter or a filled bubble covers about 4–5% of its spot, a tick about 2–3%, a stray pencil dot well under 0.5%.

/** An option is marked at or above this share of its spot. */
export const MARKED = 0.015;
/** Below MARKED but at or above this: a faint mark, worth a look. */
export const FAINT = 0.005;
/** A marked option must have at least this share of the strongest one's ink to count as marked too (else it is spill). */
const ALSO_MARKED = 0.45;

export interface OptionInk {
  value: string;
  ink: number;
}

export interface ChoiceReading {
  /** The options read as marked, in printed order; [] = left blank. */
  marked: string[];
  confidence: Confidence;
  /** Why the teacher should look ("none" when the marks are clear). */
  review: ItemReviewReason;
  /** For the teacher: "B: strong mark; others clean". */
  marksSeen: string;
}

/** Which options of one choice question are marked. */
export function readChoice(options: OptionInk[]): ChoiceReading {
  if (options.length === 0) return { marked: [], confidence: "low", review: "ambiguous_reading", marksSeen: "no options to read" };
  const sorted = [...options].sort((a, b) => b.ink - a.ink);
  const top = sorted[0];
  const marked = options.filter((o) => o.ink >= MARKED && o.ink >= top.ink * ALSO_MARKED);
  const seen = describeOptions(options, marked);
  if (marked.length === 0) {
    if (top.ink >= FAINT) return { marked: [], confidence: "low", review: "ambiguous_reading", marksSeen: `nothing clearly marked; ${seen}` };
    return { marked: [], confidence: "high", review: "none", marksSeen: "no marks; every option clean" };
  }
  if (marked.length > 1) return { marked: marked.map((o) => o.value), confidence: "medium", review: "multiple_answers", marksSeen: seen };
  const second = sorted[1]?.ink ?? 0;
  const ratio = second / top.ink;
  if (ratio >= ALSO_MARKED) return { marked: [top.value], confidence: "low", review: "ambiguous_reading", marksSeen: seen };
  if (ratio >= 0.25 || second >= MARKED) return { marked: [top.value], confidence: "medium", review: "none", marksSeen: seen };
  return { marked: [top.value], confidence: "high", review: "none", marksSeen: seen };
}

/** "B: strong mark; others clean", "B: mark; C: faint", "B and D: strong marks". */
function describeOptions(options: OptionInk[], marked: OptionInk[]): string {
  const strength = (ink: number) => (ink >= 3 * MARKED ? "strong mark" : ink >= MARKED ? "mark" : ink >= FAINT ? "faint" : "clean");
  const notable = options.filter((o) => o.ink >= FAINT);
  if (notable.length === 0) return "every option clean";
  const parts = notable.map((o) => `${o.value}: ${strength(o.ink)} (${percent(o.ink)})`);
  if (notable.length < options.length) parts.push(notable.length === 1 && marked.length === 1 ? "others clean" : "the rest clean");
  return parts.join("; ");
}

/** Written: enough added ink in the spot. Counts are pixels at OMR_DPI. */
export const WRITTEN_PIXELS = 50;
/** Some ink, but little: still read (the reading is then marked uncertain). */
export const TRACE_PIXELS = 20;

export interface WriteInReading {
  written: boolean;
  confidence: Confidence;
  marksSeen: string;
}

/** Whether something was written or drawn in a spot, from its added ink. */
export function readWriteIn(pixels: number, fraction: number): WriteInReading {
  if (pixels >= WRITTEN_PIXELS) return { written: true, confidence: "high", marksSeen: `ink in the answer spot (${percent(fraction)})` };
  if (pixels >= TRACE_PIXELS) return { written: true, confidence: "low", marksSeen: `a little ink in the answer spot (${percent(fraction)})` };
  return { written: false, confidence: "high", marksSeen: "answer spot empty" };
}

function percent(f: number): string {
  return `${(f * 100).toFixed(f >= 0.1 ? 0 : 1)}%`;
}
