import { matchesExactly, optionLettersFromPrompt } from "@/lib/grading/auto-mark";
import { sha256Hex } from "@/lib/ids";
import type { Attempt, Correctness, GradingGuidance, KeyItem, Legibility } from "@/lib/types";
import { AiError } from "./errors";
import {
  type AiCallMeta, type BlindItem, type CallOptions, type Grader, type JudgeInput, type PacketReadInput, type ReadScanInput, writesNotes,
} from "./grader";
import { itemRefs } from "./prompts";
import { gradeByReading, gradePacketByReading } from "./read-then-mark";
import type { JudgingOutput, KeyExtraction, PacketReadingOutput, ReadingItem, ReadingOutput, ScanPages } from "./schemas";

// AI_MODE=fake: a deterministic stand-in so the whole flow runs without an API key. Every "random"
// choice is derived from the PDF's bytes and a named purpose, so the same paper always grades the same.
// Like the real engines it reads each paper blind (readSubmission never sees an answer), then the program marks what it can
// and the fake judge decides the rest from the transcription alone.

type Seed = (purpose: string) => Buffer;

export interface FakeGraderOptions {
  delayMs?: number;
  /**
   * Tests: what the fake reader "sees" for an item instead of its seeded transcription (for example () => "B" for a
   * multiple-choice mark that is wrong); undefined keeps the seeded one. "" reads as a blank item.
   */
  transcribe?: (ref: string, item: BlindItem) => string | undefined;
  /**
   * Tests: what the fake "reads" in the crop of a written answer spot (mark detection); undefined keeps the default,
   * "Sample answer for <ref>" (which the fake judge marks like its other sample answers).
   */
  transcribeCrop?: (ref: string) => string | undefined;
}

function seedFor(pdf: Uint8Array): Seed {
  const pdfHash = sha256Hex(pdf);
  return (purpose) => Buffer.from(sha256Hex(`${pdfHash}:${purpose}`), "hex");
}

/** A uniform number in [0, 1) from two bytes of a seed. */
function fraction(bytes: Buffer, offset = 0): number {
  return bytes.readUInt16BE(offset) / 0x10000;
}

export function createFakeGrader(o: FakeGraderOptions = {}): Grader {
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

  const grader: Grader = {
    mode: "fake",
    engine: "fake",
    async extractKey(input, options = {}) {
      const meta = await simulateCall(seedFor(input.keyPdf), options);
      return { output: fakeKey(input.pageCount), meta };
    },
    async readSubmission(input, options = {}) {
      const seed = seedFor(input.studentPdf);
      const meta = await simulateCall(seed, options);
      return { output: fakeReading(seed, input.items, input.sections.map((s) => s.label), input.studentPageCount, o.transcribe), meta };
    },
    async judgeSubmission(input, options = {}) {
      // Text only, like the real judge: seeded by the transcriptions, never by a PDF.
      const meta = await simulateCall(seedForText(JSON.stringify(input.reading)), options);
      return { output: fakeJudging(input), meta };
    },
    gradeSubmission: (input, options) => gradeByReading(grader, input, options),
    async readScanPages(input, options = {}) {
      const seed = seedFor(input.chunkPdf);
      const meta = await simulateCall(seed, options);
      return { output: fakeScanPages(seed, input), meta };
    },
    async readPacketChunk(input, options = {}) {
      const seed = seedFor(input.chunkPdf);
      const meta = await simulateCall(seed, options);
      return { output: fakePacketReading(seed, input, o.transcribe), meta };
    },
    gradePacketChunk: (input, options) => gradePacketByReading(grader, input, options),
    async transcribeCrops(input, options = {}) {
      // The fake can't read images: a repeatable placeholder per crop, seeded by the crops themselves.
      const meta = await simulateCall(seedForText(input.crops.map((c) => sha256Hex(c.png)).join(":")), options);
      return {
        output: {
          crops: input.crops.map((c) => ({
            id: c.id,
            text: o.transcribeCrop?.(c.id) ?? (c.kind === "diagram" ? "A labelled drawing" : `Sample answer for ${c.id}`),
            confidence: "high" as const,
          })),
        },
        meta,
      };
    },
    async proposeSpots(input, options = {}) {
      // One write-in spot per key item, stacked down the page, for the teacher to move onto the real answer spots.
      const meta = await simulateCall(seedForText(sha256Hex(input.page.png)), options);
      const labels = input.itemLabels.length > 0 ? input.itemLabels : ["1"];
      const step = Math.min(0.12, 0.8 / labels.length);
      return {
        output: {
          questions: input.pageNumber > 1 ? [] : labels.map((label, i) => ({
            label, kind: "write_in" as const, options: [],
            answer_box: [0.1 * input.page.width, (0.12 + i * step) * input.page.height, 0.9 * input.page.width, (0.12 + i * step + step * 0.7) * input.page.height],
          })),
        },
        meta,
      };
    },
  };
  return grader;
}

function seedForText(text: string): Seed {
  const hash = sha256Hex(text);
  return (purpose) => Buffer.from(sha256Hex(`${hash}:${purpose}`), "hex");
}

const PRACTICE_SUMMARY = "Fake AI mode: these judgments are repeatable placeholders, not a real reading of the paper.";
const PRACTICE_FEEDBACK = "This is sample feedback from the practice grader. Keep showing your steps, "
  + "and check each answer once more before you hand it in.";

/** One paper read blind: the seeded outcome's transcription for each item (or the test's `transcribe`). Pages are paper pages. */
function fakeReading(
  seed: Seed, items: BlindItem[], sectionLabels: string[], pageCount: number, transcribe: FakeGraderOptions["transcribe"],
): ReadingOutput {
  return {
    student: fakeStudent(seed, sectionLabels),
    document_check: fakeDocumentCheck(seed),
    items: itemRefs(items.length).map((ref, i) => fakeReadItem(seed, ref, items[i], pageCount, transcribe)),
    integrity: { grader_directed_text_found: false, excerpt: "" },
    unmatched_work: "",
  };
}

function fakeReadItem(seed: Seed, ref: string, item: BlindItem, pageCount: number, transcribe: FakeGraderOptions["transcribe"]): ReadingItem {
  const bytes = seed(ref);
  const page = 1 + (bytes[3] % Math.max(pageCount, 1));
  const scripted = transcribe?.(ref, item);
  if (scripted !== undefined) {
    const blank = scripted.trim() === "";
    return {
      ref, pages: blank ? [] : [page], student_answer: scripted, marks_seen: blank || item.answerType !== "multiple_choice" ? "" : `${scripted} circled`,
      legibility: blank ? "no_writing" : "clear", attempt: blank ? "none" : "complete", reading_confidence: "high",
    };
  }
  const outcome = pickOutcome(fraction(bytes));
  const lowConfidence = bytes[2] % 8 === 0;
  // A multiple-choice question that lists its options is answered with one of them, which the program then marks.
  const options = item.answerType === "multiple_choice" ? optionLettersFromPrompt(item.prompt) : null;
  if (options && outcome.attempt !== "none" && outcome.legibility !== "illegible") {
    const letter = options[bytes[4] % options.length];
    return {
      ref, pages: [page], student_answer: letter, marks_seen: `${letter} circled`, legibility: "clear", attempt: "complete",
      reading_confidence: lowConfidence ? "low" : "high",
    };
  }
  return {
    ref,
    pages: outcome.attempt === "none" ? [] : [page],
    student_answer: outcome.answer(ref),
    marks_seen: "",
    legibility: outcome.legibility,
    attempt: outcome.attempt,
    reading_confidence: lowConfidence ? "low" : "high",
  };
}

/**
 * The fake judge: the program's marks as given; any other item by the outcome its transcription came from (the fake's
 * transcriptions name it: "Sample answer for Q2 with a slip"), else an exact match with the key or incorrect. The teacher's
 * newest ruling on the same answer to the same item wins. With notes off only the items left to it are returned, without notes.
 */
function fakeJudging(input: JudgeInput): JudgingOutput {
  const writeNotes = writesNotes(input);
  const refs = itemRefs(input.items.length);
  const entries = input.reading.filter((r) => writeNotes || r.mark === null);
  return {
    items: entries.map(({ ref, item: read, mark }) => {
      const keyItem = input.items[refs.indexOf(ref)];
      const outcome = OUTCOMES.find((candidate) => candidate.answer(ref) === read.student_answer && candidate.attempt === read.attempt);
      const notes = {
        what_student_did: writeNotes ? (outcome?.did(ref) ?? `You answered ${ref} with "${read.student_answer}".`) : "",
        feedback: writeNotes ? (outcome?.feedback(ref) ?? `Check ${ref} against what the question asks.`) : "",
        teacher_note: writeNotes && read.reading_confidence === "low" ? "Practice grader: marked low confidence to exercise the review flow." : "",
      };
      if (mark) {
        return { ref, attempt: read.attempt, correctness: mark.correctness, confidence: mark.confidence, review_reason: mark.review_reason, ...notes };
      }
      const judged = followRuling(read, keyItem, input.guidance)
        ?? (outcome
          ? { attempt: outcome.attempt, correctness: outcome.correctness, teacherNote: null }
          : {
            attempt: read.attempt,
            correctness: keyItem && matchesExactly(read.student_answer, [keyItem.expectedAnswer, ...keyItem.acceptableAnswers])
              ? "correct" as const
              : "incorrect" as const,
            teacherNote: null,
          });
      return {
        ref,
        attempt: judged.attempt,
        correctness: judged.correctness,
        confidence: judged.teacherNote ? "high" : read.reading_confidence === "low" ? "low" : "high",
        review_reason: "none",
        ...notes,
        ...(judged.teacherNote && writeNotes ? { teacher_note: judged.teacherNote } : {}),
      };
    }),
    overall_feedback: writeNotes ? PRACTICE_FEEDBACK : "",
    teacher_summary: writeNotes ? PRACTICE_SUMMARY : "",
  };
}

/**
 * Reading a chunk of a scan in one pass, like fakeScanPages: identical worksheets of `keyPageCount` pages (2 without a key
 * page count) from the scan's first page, each read like a paper of its own (seeded by the chunk and the paper's first
 * page). A paper cut off by the chunk's start continues from the chunk before; one cut off by its end may continue after it.
 */
function fakePacketReading(seed: Seed, input: PacketReadInput, transcribe: FakeGraderOptions["transcribe"]): PacketReadingOutput {
  const k = Math.max(1, input.keyPageCount ?? 2);
  const lastPage = input.firstPage + input.chunkPageCount - 1;
  const papers: PacketReadingOutput["papers"] = [];
  for (let paperStart = input.firstPage - ((input.firstPage - 1) % k); paperStart <= lastPage; paperStart += k) {
    const first = Math.max(paperStart, input.firstPage);
    const last = Math.min(paperStart + k - 1, lastPage, input.totalPages);
    const paperSeed: Seed = (purpose) => seed(`paper:${first}:${purpose}`);
    const pageCount = last - first + 1;
    const toChunk = (paperPage: number) => paperPage + first - input.firstPage;
    const reading = fakeReading(paperSeed, input.items, input.sections.map((section) => section.label), pageCount, transcribe);
    papers.push({
      first_page: toChunk(1),
      last_page: toChunk(pageCount),
      continues_from_previous_chunk: paperStart < input.firstPage,
      may_continue_after_chunk: paperStart + k - 1 > lastPage && lastPage < input.totalPages,
      boundary_confidence: "high",
      ...reading,
      items: reading.items.map((item) => ({ ...item, pages: item.pages.map(toChunk) })),
    });
  }
  return { papers, skipped_pages: [] };
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
        grading_criteria: "Full credit names chlorophyll and explains that green light is reflected.", points: 3, page: page(3) }),
    ],
    stated_total_points: 10,
    notes: "Fake AI mode: these items are samples and were not read from the uploaded PDF.",
    questions_for_teacher: [
      { id: "q1", kind: "missing_answer", item_label: "4",
        question: "Question 4 shows no drawing in the key. What should a full-credit plant cell drawing include?",
        suggested_answer: "A plant cell with the cell wall, cell membrane, nucleus and chloroplasts labeled.", choices: [] },
      { id: "q2", kind: "accept_equivalents", item_label: "3a",
        question: "In question 3, should chemical formulas such as CO2 and O2 count the same as the gas names?",
        suggested_answer: "Yes", choices: ["Yes", "No"] },
    ],
    suggested_title: "Plants and Photosynthesis",
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

function fakeStudent(seed: Seed, sectionLabels: string[]): ReadingOutput["student"] {
  const nameBytes = seed("name");
  const name = nameBytes[0] % 10 === 0 ? null : `Test Student ${letterTag(nameBytes.toString("hex").slice(2, 6))}`;
  const sectionBytes = seed("section");
  const section = sectionLabels.length === 0 || sectionBytes[0] % 10 === 0
    ? null
    : sectionLabels[sectionBytes[1] % sectionLabels.length];
  return { name, name_confidence: "high", section_raw: section, section_match: section, multiple_students_detected: false };
}

function fakeDocumentCheck(seed: Seed): ReadingOutput["document_check"] {
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

/**
 * The teacher's newest ruling on the same answer to the same item, as the fake judge applies it. The fake's answers repeat
 * across papers ("Sample answer for Q2"), so a correction visibly changes other papers in the demo.
 */
function followRuling(
  read: ReadingItem, item: KeyItem | undefined, guidance: GradingGuidance | undefined,
): { attempt: Attempt; correctness: Correctness; teacherNote: string } | null {
  if (!item) return null;
  const ruling = guidance?.lessons.find((l) => l.itemId === item.id && l.studentAnswer === read.student_answer && l.teacherAttempt !== null);
  if (!ruling || ruling.teacherAttempt === null || ruling.teacherCorrectness === null) return null;
  return { attempt: ruling.teacherAttempt, correctness: ruling.teacherCorrectness, teacherNote: "Practice grader: followed your ruling on this answer." };
}

/** A scan of identical worksheets, `keyPageCount` pages each (2 without a key page count), every paper named. */
function fakeScanPages(seed: Seed, input: ReadScanInput): ScanPages {
  const k = Math.max(1, input.keyPageCount ?? 2);
  return {
    pages: Array.from({ length: input.chunkPageCount }, (_, idx) => {
      const abs = input.firstPage + idx;
      const pos = (abs - 1) % k;
      const paper = Math.floor((abs - 1) / k);
      return {
        chunk_page: idx + 1,
        kind: "student_work",
        starts_new_paper: pos === 0,
        student_name: pos === 0 ? `Test Student ${letterTag(sha256Hex(String(paper)).slice(0, 4))}` : null,
        section_raw: pos === 0 && input.sections.length > 0 ? input.sections[paper % input.sections.length].label : null,
        page_marker: `${pos + 1} of ${k}`,
        worksheet_page: pos + 1,
        confidence: seed(`page:${idx}`)[0] % 15 === 0 ? "low" : "high",
        note: "",
      };
    }),
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
