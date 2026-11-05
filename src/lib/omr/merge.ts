import type { DetectedSpot } from "@/lib/ai/grader";
import type { CropTranscriptions, ReadingItem, ReadingOutput } from "@/lib/ai/schemas";
import type { AutoMark } from "@/lib/grading/auto-mark";
import type { Confidence, KeyItem } from "@/lib/types";
import { markChoice } from "./map-key";
import type { SpotEvidence } from "./types";

// Mark detection's readings in the shape of the blind reading (pure): each item read from its answer spot replaces the AI's
// reading of it, with the program's mark when the marks decide it (a choice, a blank) and the spot as evidence.

export interface SpotItem {
  reading: ReadingItem;
  /** The program's mark; null: the judge decides; undefined: compared like any reading (autoMark). */
  mark: AutoMark | null | undefined;
  spot: SpotEvidence;
}

export const DIAGRAM_NOTE = "a drawing: the AI described it from the crop, so check it";
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * The readings of the detected items, by ref. A written spot needs its transcription; without one (the engine can't read
 * crops, or left it out) the item is left to the AI's reading of the page.
 */
export function spotReadings(
  detected: DetectedSpot[], items: Array<Pick<KeyItem, "id" | "expectedAnswer" | "acceptableAnswers">>, refs: string[],
  transcriptions: CropTranscriptions | null, ctx: { ruledItemIds: Set<string>; teacherNotes: string },
): Map<string, SpotItem> {
  const byId = new Map((transcriptions?.crops ?? []).map((c) => [normalizeRef(c.id), c]));
  const out = new Map<string, SpotItem>();
  for (const d of detected) {
    const index = refs.indexOf(d.ref);
    const item = items[index];
    if (!item) continue;
    const page = d.evidence.page;
    if (d.kind === "choice" && d.choice) {
      const c = d.choice;
      const blank = c.marked.length === 0;
      out.set(d.ref, {
        reading: {
          ref: d.ref, pages: blank ? [] : [page], student_answer: c.marked.join(", "), marks_seen: c.marksSeen,
          legibility: blank ? "no_writing" : "clear", attempt: blank ? "none" : "complete", reading_confidence: c.confidence,
        },
        mark: markChoice(item, d.values, c, d.multi, { hasRuling: ctx.ruledItemIds.has(item.id), teacherNotes: ctx.teacherNotes }),
        spot: { ...d.evidence, marked: c.marked },
      });
      continue;
    }
    const w = d.written;
    if (!w) continue;
    if (!w.written) {
      out.set(d.ref, {
        reading: {
          ref: d.ref, pages: [], student_answer: "", marks_seen: w.marksSeen, legibility: "no_writing", attempt: "none",
          reading_confidence: w.confidence,
        },
        mark: { correctness: "no_answer", confidence: w.confidence, review_reason: "none", basis: "blank" },
        spot: d.evidence,
      });
      continue;
    }
    const t = byId.get(normalizeRef(d.ref));
    if (!t) continue;
    const text = t.text.trim();
    let confidence: Confidence = RANK[t.confidence] < RANK[w.confidence] ? t.confidence : w.confidence;
    if (d.kind === "diagram") confidence = "low";
    out.set(d.ref, {
      reading: {
        ref: d.ref, pages: [page], student_answer: text,
        marks_seen: d.kind === "diagram" ? `${w.marksSeen}; ${DIAGRAM_NOTE}` : w.marksSeen,
        legibility: text.includes("[illegible]") ? (text.replace(/\[illegible\]/g, "").trim() === "" ? "illegible" : "partly_illegible") : "clear",
        attempt: "complete", reading_confidence: confidence,
      },
      mark: undefined,
      spot: d.evidence,
    });
  }
  return out;
}

/** The reading with the spot readings in place of the AI's (in key order; an item neither read stays absent). */
export function withSpotReadings(reading: ReadingOutput, spots: Map<string, SpotItem>, refs: string[]): ReadingOutput {
  const ai = new Map(reading.items.map((item) => [normalizeRef(item.ref), item]));
  const items = refs.flatMap((ref) => {
    const fromSpot = spots.get(ref)?.reading;
    if (fromSpot) return [fromSpot];
    const read = ai.get(ref);
    return read ? [read] : [];
  });
  const attempted = items.some((item) => item.attempt !== "none");
  return {
    ...reading,
    items,
    // A page-1-only identity reading can't see the answers: what the marks show decides "blank".
    document_check: reading.document_check.match === "blank" && attempted
      ? { ...reading.document_check, match: "matches", note: "" }
      : reading.document_check,
  };
}

function normalizeRef(ref: string): string {
  return ref.replace(/[[\]]/g, "").trim().toUpperCase();
}
