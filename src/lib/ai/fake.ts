import { sha256Hex } from "@/lib/ids";
import type { Attempt, Correctness, Legibility } from "@/lib/types";
import { AiError } from "./errors";
import type { AiCallMeta, CallOptions, Grader } from "./grader";
import { itemRefs } from "./prompts";
import type { GradingOutput, KeyExtraction } from "./schemas";

// AI_MODE=fake: a deterministic stand-in so the whole flow runs without an API key. Every "random"
// choice is derived from the PDF's bytes and a named purpose, so the same paper always grades the same.

type Seed = (purpose: string) => Buffer;

function seedFor(pdf: Uint8Array): Seed {
  const pdfHash = sha256Hex(pdf);
  return (purpose) => Buffer.from(sha256Hex(`${pdfHash}:${purpose}`), "hex");
}

/** A uniform number in [0, 1) from two bytes of a seed. */
function fraction(bytes: Buffer, offset = 0): number {
  return bytes.readUInt16BE(offset) / 0x10000;
}

export function createFakeGrader(o: { delayMs?: number } = {}): Grader {
  async function simulateCall(seed: Seed, options: CallOptions): Promise<AiCallMeta> {
    const startedAt = performance.now();
    await sleep(o.delayMs ?? 300 + Math.floor(fraction(seed("delay")) * 1200), options.signal);
    return {
      requestedModel: "fake",
      servedModel: "fake",
      fallbackUsed: false,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  return {
    mode: "fake",
    async extractKey(input, options = {}) {
      const meta = await simulateCall(seedFor(input.keyPdf), options);
      return { output: fakeKey(input.pageCount), meta };
    },
    async gradeSubmission(input, options = {}) {
      const seed = seedFor(input.studentPdf);
      const meta = await simulateCall(seed, options);
      const refs = itemRefs(input.items.length);
      const output: GradingOutput = {
        student: fakeStudent(seed, input.sections.map((s) => s.label)),
        document_check: fakeDocumentCheck(seed),
        items: refs.map((ref) => fakeItem(seed, ref, input.studentPageCount)),
        integrity: { grader_directed_text_found: false, excerpt: "" },
        unmatched_work: "",
        overall_feedback: "This is sample feedback from the practice grader. Keep showing your steps, "
          + "and check each answer once more before you hand it in.",
        teacher_summary: "Fake AI mode: these judgments are repeatable placeholders, not a real reading of the paper.",
      };
      return { output, refs, keyPdfIncluded: false, meta };
    },
  };
}

function fakeKey(pageCount: number): KeyExtraction {
  const page = (n: number) => Math.min(n, Math.max(pageCount, 1));
  const item = (fields: Partial<KeyExtraction["items"][number]> & Pick<KeyExtraction["items"][number], "label" | "answer_type">) => ({
    group_label: "", prompt: "", expected_answer: "", acceptable_answers: [], grading_criteria: "", points: 1, group_points: null,
    page: page(1), answer_source: "key" as const, confidence: "high" as const, note: "", ...fields,
  });
  return {
    document_kind: "answer_key",
    items: [
      item({ label: "1", answer_type: "multiple_choice", prompt: "Which process do plants use to make food from sunlight?",
        expected_answer: "B) photosynthesis", acceptable_answers: ["B"] }),
      item({ label: "2", answer_type: "numeric", prompt: "Solve 3/x = 9/12.", expected_answer: "x = 4",
        acceptable_answers: ["4"], grading_criteria: "Must show cross-multiplication.", points: 2 }),
      // Question 3's value is printed only for the whole question, so its parts share it.
      item({ label: "3a", group_label: "3", answer_type: "short_answer", prompt: "Which gas do plants take in?",
        expected_answer: "carbon dioxide", acceptable_answers: ["CO2"], points: null, group_points: 2 }),
      item({ label: "3b", group_label: "3", answer_type: "short_answer", prompt: "Which gas do plants give off?",
        expected_answer: "oxygen", acceptable_answers: ["O2"], points: null, group_points: 2 }),
      item({ label: "4", answer_type: "diagram", prompt: "Draw and label a plant cell.",
        expected_answer: "A plant cell with the cell wall, cell membrane, nucleus and chloroplasts labeled.", points: 2,
        page: page(2), answer_source: "ai_proposed", confidence: "low",
        note: "The key shows no drawing for this item, so this expected answer was proposed by the AI." }),
      item({ label: "5", answer_type: "long_answer", prompt: "Explain why leaves look green.",
        expected_answer: "Chlorophyll absorbs red and blue light and reflects green light.",
        grading_criteria: "Full credit names chlorophyll and explains that green light is reflected.", points: 3, page: page(2) }),
    ],
    stated_total_points: 10,
    notes: "Fake AI mode: these items are samples and were not read from the uploaded PDF.",
  };
}

/**
 * Four hex digits of the fake student's seed spelled with letters (0-9a-f → A-P / a-p): names are matched
 * by a letters-only key (`nameKey`), so digits would be dropped and distinct fake students would merge as
 * one student's resubmissions.
 */
function letterTag(hex4: string): string {
  const letters = Array.from(hex4, (c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  return letters.charAt(0).toUpperCase() + letters.slice(1);
}

function fakeStudent(seed: Seed, sectionLabels: string[]): GradingOutput["student"] {
  const nameBytes = seed("name");
  const name = nameBytes[0] % 10 === 0 ? null : `Test Student ${letterTag(nameBytes.toString("hex").slice(2, 6))}`;
  const sectionBytes = seed("section");
  const section = sectionLabels.length === 0 || sectionBytes[0] % 10 === 0
    ? null
    : sectionLabels[sectionBytes[1] % sectionLabels.length];
  return { name, name_confidence: "high", section_raw: section, section_match: section, multiple_students_detected: false };
}

function fakeDocumentCheck(seed: Seed): GradingOutput["document_check"] {
  return seed("match")[0] % 20 === 0
    ? { match: "uncertain", pages_appear_missing: false, note: "Practice grader: could not confirm this paper belongs to the assignment." }
    : { match: "matches", pages_appear_missing: false, note: "" };
}

interface Outcome {
  share: number;
  attempt: Attempt;
  correctness: Correctness;
  legibility: Legibility;
  answer: (ref: string) => string;
  did: (ref: string) => string;
  feedback: (ref: string) => string;
}

const OUTCOMES: Outcome[] = [
  { share: 0.6, attempt: "complete", correctness: "correct", legibility: "clear", answer: (r) => `Sample answer for ${r}`,
    did: (r) => `You answered ${r} completely and showed your steps.`,
    feedback: (r) => `Nice work on ${r}: your answer addresses exactly what was asked.` },
  { share: 0.1, attempt: "complete", correctness: "minor_error", legibility: "clear", answer: (r) => `Sample answer for ${r} with a slip`,
    did: (r) => `You worked through ${r} but made a small slip in the last step.`,
    feedback: (r) => `Recheck the final step of ${r}; the method is right.` },
  { share: 0.15, attempt: "partial", correctness: "partially_correct", legibility: "clear", answer: (r) => `Partial work for ${r}`,
    did: (r) => `You set up ${r} but stopped before reaching an answer.`,
    feedback: (r) => `Finish ${r}: what is the next step after your setup?` },
  { share: 0.1, attempt: "none", correctness: "no_answer", legibility: "no_writing", answer: () => "",
    did: (r) => `You left ${r} blank.`,
    feedback: (r) => `Give ${r} a try next time; even a first step counts.` },
  { share: 0.05, attempt: "complete", correctness: "cannot_judge", legibility: "illegible", answer: () => "[illegible]",
    did: (r) => `You wrote an answer for ${r}, but it was hard to read.`,
    feedback: (r) => `Write ${r} a little more clearly so your work can be checked.` },
];

function pickOutcome(r: number): Outcome {
  let cumulative = 0;
  for (const outcome of OUTCOMES) {
    cumulative += outcome.share;
    if (r < cumulative) return outcome;
  }
  return OUTCOMES[OUTCOMES.length - 1];
}

function fakeItem(seed: Seed, ref: string, pageCount: number): GradingOutput["items"][number] {
  const bytes = seed(ref);
  const outcome = pickOutcome(fraction(bytes));
  const lowConfidence = bytes[2] % 8 === 0;
  return {
    ref,
    pages: outcome.attempt === "none" ? [] : [1 + (bytes[3] % Math.max(pageCount, 1))],
    student_answer: outcome.answer(ref),
    legibility: outcome.legibility,
    attempt: outcome.attempt,
    correctness: outcome.correctness,
    confidence: lowConfidence ? "low" : "high",
    review_reason: "none",
    what_student_did: outcome.did(ref),
    feedback: outcome.feedback(ref),
    teacher_note: lowConfidence ? "Practice grader: marked low confidence to exercise the review flow." : "",
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const aborted = () => new AiError("aborted", "The AI call was aborted.", { retryable: true });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
