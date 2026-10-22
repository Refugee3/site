import * as z from "zod";
import { SPOT_KINDS } from "@/lib/omr/types";
import {
  ANSWER_TYPES,
  ATTEMPTS,
  CONFIDENCE,
  CORRECTNESS,
  DOCUMENT_MATCHES,
  ITEM_REVIEW_REASONS,
  JUDGED_BY,
  KEY_QUESTION_KINDS,
  LEGIBILITY,
  SCAN_PAGE_KINDS,
} from "@/lib/types";

// Structured-output schemas. They deliberately use no .int(), .min(), .max(), .optional() or
// string formats: the API rejects or ignores those keywords, so every limit is enforced in code.

const conf = z.enum(CONFIDENCE);

export const KeyExtractionSchema = z.object({
  document_kind: z.enum(["answer_key", "blank_worksheet", "student_work", "unrelated"]),
  items: z.array(z.object({
    label: z.string(), group_label: z.string(), prompt: z.string(), answer_type: z.enum(ANSWER_TYPES),
    expected_answer: z.string(), acceptable_answers: z.array(z.string()), grading_criteria: z.string(),
    points: z.number().nullable(), group_points: z.number().nullable(), page: z.number().nullable(),
    answer_source: z.enum(["key", "ai_proposed"]), confidence: conf, note: z.string(),
  })),
  stated_total_points: z.number().nullable(),
  notes: z.string(),
  // A few short questions for the teacher, asked only when an answer would really change the key; answered without another AI call.
  questions_for_teacher: z.array(z.object({
    id: z.string(), kind: z.enum(KEY_QUESTION_KINDS), item_label: z.string().nullable(), question: z.string(),
    suggested_answer: z.string().nullable(), choices: z.array(z.string()),
  })),
  suggested_title: z.string().nullable(),
});
export type KeyExtraction = z.infer<typeof KeyExtractionSchema>;

// Grading a paper takes two AI calls and a program in between (src/lib/ai/read-then-mark.ts):
// 1. READ: the model transcribes each item from the pages without ever seeing the answer key (ReadingOutputSchema);
// 2. MARK: code compares the transcriptions with the key where the answer is objective (src/lib/grading/auto-mark.ts);
// 3. JUDGE: the model judges the remaining items from the transcriptions alone, text only (JudgingOutputSchema).
// The three are combined into a GradingOutput, which is what everything downstream (reconcile, scoring, views) reads.
// Field order = generation order: identify → check → read → summarize.
const gradingStudent = z.object({ name: z.string().nullable(), name_confidence: conf, section_raw: z.string().nullable(),
  section_match: z.string().nullable(), multiple_students_detected: z.boolean() });
const documentCheck = z.object({ match: z.enum(DOCUMENT_MATCHES), pages_appear_missing: z.boolean(), note: z.string() });
const integrity = z.object({ grader_directed_text_found: z.boolean(), excerpt: z.string() });

/** One item as read from the pages, without the key: what the student marked, never whether it is right. */
const readItem = z.object({
  ref: z.string(), pages: z.array(z.number()), student_answer: z.string(), marks_seen: z.string(), legibility: z.enum(LEGIBILITY),
  attempt: z.enum(ATTEMPTS), reading_confidence: conf,
});
const paperReading = {
  student: gradingStudent,
  document_check: documentCheck,
  items: z.array(readItem),
  integrity,
  unmatched_work: z.string(),
};

/** The blind reading of one paper (the READ call's answer). */
export const ReadingOutputSchema = z.object(paperReading);
export type ReadingOutput = z.infer<typeof ReadingOutputSchema>;
export type ReadingItem = ReadingOutput["items"][number];

/** One item judged from its transcription (the JUDGE call). With notes on, every item gets its notes too. */
const judgedItem = z.object({
  ref: z.string(), attempt: z.enum(ATTEMPTS), correctness: z.enum(CORRECTNESS), confidence: conf, review_reason: z.enum(ITEM_REVIEW_REASONS),
});

/** The JUDGE call's answer with notes: one entry per item (the program's items only get their notes from it). */
export const JudgingOutputSchema = z.object({
  items: z.array(judgedItem.extend({ what_student_did: z.string(), feedback: z.string(), teacher_note: z.string() })),
  overall_feedback: z.string(),
  teacher_summary: z.string(),
});
export type JudgingOutput = z.infer<typeof JudgingOutputSchema>;

/** The JUDGE call's answer when the assignment's notes are off: only the items the program left to it, without notes. */
export const JudgingOutputWithoutNotesSchema = z.object({ items: z.array(judgedItem) });
export type JudgingOutputWithoutNotes = z.infer<typeof JudgingOutputWithoutNotesSchema>;

/** A judging without notes as a JudgingOutput whose notes are all "". */
export function judgingWithEmptyNotes(o: JudgingOutputWithoutNotes): JudgingOutput {
  return {
    items: o.items.map((item) => ({ ...item, what_student_did: "", feedback: "", teacher_note: "" })),
    overall_feedback: "",
    teacher_summary: "",
  };
}

// The combined grading of one paper. Never sent to the model as a schema (the model only ever answers ReadingOutputSchema,
// PacketReadingOutputSchema or a JudgingOutput schema), so it may carry optional fields: judged_by and marks_seen are absent in
// gradings stored before papers were read without the key.
const box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
/** Where mark detection read an item (src/lib/omr/types.ts SpotEvidence); absent for items the AI read. */
export const SpotEvidenceSchema = z.object({
  kind: z.enum(SPOT_KINDS),
  page: z.number(),
  crop: box,
  map: z.object({ a: z.number(), b: z.number(), c: z.number(), d: z.number(), e: z.number(), f: z.number() }),
  options: z.array(z.object({ value: z.string(), box, ink: z.number() })).optional(),
  marked: z.array(z.string()).optional(),
  boxes: z.array(box).optional(),
  ink: z.number().optional(),
});

const itemWithNotes = z.object({
  ref: z.string(), pages: z.array(z.number()), student_answer: z.string(), legibility: z.enum(LEGIBILITY),
  attempt: z.enum(ATTEMPTS), correctness: z.enum(CORRECTNESS), confidence: conf, review_reason: z.enum(ITEM_REVIEW_REASONS),
  what_student_did: z.string(), feedback: z.string(), teacher_note: z.string(),
  judged_by: z.enum(JUDGED_BY).optional(), marks_seen: z.string().optional(), spot: SpotEvidenceSchema.optional(),
});

/** How mark detection went for a paper: used, or skipped because the paper couldn't be lined up with the blank worksheet. */
const answerSpotsStatus = z.object({ status: z.enum(["used", "unaligned"]), note: z.string() });

export const GradingOutputSchema = z.object({
  student: gradingStudent,
  document_check: documentCheck,
  items: z.array(itemWithNotes),
  integrity,
  unmatched_work: z.string(),
  overall_feedback: z.string(),
  teacher_summary: z.string(),
  answer_spots: answerSpotsStatus.optional(),
});
export type GradingOutput = z.infer<typeof GradingOutputSchema>;

// A whole-class scan in one pass: each chunk of pages is read blind as the papers found in it, each read like one paper
// (same fields, in the same order), plus the pages that belong to no paper. Pages are chunk pages (1 = the chunk's first
// page), including each item's pages. Each paper is then marked and judged on its own, giving PacketOutput.
export const SKIPPED_PAGE_KINDS = ["blank", "cover_or_separator", "answer_key", "other"] as const;
const packetBoundary = {
  first_page: z.number(),
  last_page: z.number(),
  continues_from_previous_chunk: z.boolean(),
  may_continue_after_chunk: z.boolean(),
  boundary_confidence: conf,
};
const skippedPage = z.object({ page: z.number(), kind: z.enum(SKIPPED_PAGE_KINDS) });

/** The blind reading of one chunk of a scan (the one-pass READ call's answer). */
export const PacketReadingOutputSchema = z.object({
  papers: z.array(z.object({ ...packetBoundary, ...paperReading })),
  skipped_pages: z.array(skippedPage),
});
export type PacketReadingOutput = z.infer<typeof PacketReadingOutputSchema>;

/**
 * A chunk's papers, each read, marked and judged (internal, like GradingOutputSchema). `timing`: the paper's share of the
 * chunk's reading time and its judge call's time, in ms (null: no judge call); absent in answers saved before it was recorded.
 */
export const PacketOutputSchema = z.object({
  papers: z.array(z.object({
    ...packetBoundary,
    timing: z.object({ readMs: z.number(), judgeMs: z.number().nullable() }).optional(),
    student: gradingStudent,
    document_check: documentCheck,
    items: z.array(itemWithNotes),
    integrity,
    unmatched_work: z.string(),
    overall_feedback: z.string(),
    teacher_summary: z.string(),
    answer_spots: answerSpotsStatus.optional(),
  })),
  skipped_pages: z.array(skippedPage),
});
export type PacketOutput = z.infer<typeof PacketOutputSchema>;
export type PacketPaper = PacketOutput["papers"][number];

export const ScanPagesSchema = z.object({
  pages: z.array(z.object({
    chunk_page: z.number(),
    kind: z.enum(SCAN_PAGE_KINDS),
    starts_new_paper: z.boolean(),
    student_name: z.string().nullable(),
    section_raw: z.string().nullable(),
    page_marker: z.string().nullable(),
    worksheet_page: z.number().nullable(),
    confidence: conf,
    note: z.string(),
  })),
});
export type ScanPages = z.infer<typeof ScanPagesSchema>;

// Mark detection (src/lib/omr): the AI only transcribes crops of written answer spots, and proposes the spots of a scanned
// blank worksheet.

/** The transcription of each crop, by its id. */
export const CropTranscriptionSchema = z.object({
  crops: z.array(z.object({ id: z.string(), text: z.string(), confidence: conf })),
});
export type CropTranscriptions = z.infer<typeof CropTranscriptionSchema>;

/** The answer spots the AI sees on one blank page, in the image's pixels: [x0, y0, x1, y1]. */
export const SpotProposalSchema = z.object({
  questions: z.array(z.object({
    label: z.string(),
    kind: z.enum(["choice", "write_in"]),
    options: z.array(z.object({ label: z.string(), box: z.array(z.number()) })),
    answer_box: z.array(z.number()).nullable(),
  })),
});
export type SpotProposal = z.infer<typeof SpotProposalSchema>;

export interface JsonSchemaOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

const formatCache = new WeakMap<z.ZodType, JsonSchemaOutputFormat>();

/**
 * The `output_config.format` for a schema. Built with zod's own converter rather than the SDK's
 * helper, because the helper moves `enum` into `description` and the enums would go unenforced.
 */
export function outputFormat(schema: z.ZodType): JsonSchemaOutputFormat {
  let format = formatCache.get(schema);
  if (!format) {
    const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) };
    delete jsonSchema.$schema; // the API takes the schema body without a dialect URI
    format = { type: "json_schema", schema: jsonSchema };
    formatCache.set(schema, format);
  }
  return format;
}
