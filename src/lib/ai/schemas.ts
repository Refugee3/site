import * as z from "zod";
import { ANSWER_TYPES, ATTEMPTS, CONFIDENCE, CORRECTNESS, DOCUMENT_MATCHES, ITEM_REVIEW_REASONS, LEGIBILITY } from "@/lib/types";

// Structured-output schemas. They deliberately use no .int(), .min(), .max(), .optional() or
// string formats: the API rejects or ignores those keywords, so every limit is enforced in code.

const conf = z.enum(CONFIDENCE);

export const KeyExtractionSchema = z.object({
  document_kind: z.enum(["answer_key", "blank_worksheet", "student_work", "unrelated"]),
  items: z.array(z.object({
    label: z.string(), group_label: z.string(), prompt: z.string(), answer_type: z.enum(ANSWER_TYPES),
    expected_answer: z.string(), acceptable_answers: z.array(z.string()), grading_criteria: z.string(),
    points: z.number().nullable(), page: z.number().nullable(),
    answer_source: z.enum(["key", "ai_proposed"]), confidence: conf, note: z.string(),
  })),
  stated_total_points: z.number().nullable(),
  notes: z.string(),
});
export type KeyExtraction = z.infer<typeof KeyExtractionSchema>;

export const GradingOutputSchema = z.object({ // field order = generation order: identify → check → read+judge → summarize
  student: z.object({ name: z.string().nullable(), name_confidence: conf, section_raw: z.string().nullable(),
    section_match: z.string().nullable(), multiple_students_detected: z.boolean() }),
  document_check: z.object({ match: z.enum(DOCUMENT_MATCHES), pages_appear_missing: z.boolean(), note: z.string() }),
  items: z.array(z.object({
    ref: z.string(), pages: z.array(z.number()), student_answer: z.string(), legibility: z.enum(LEGIBILITY),
    attempt: z.enum(ATTEMPTS), correctness: z.enum(CORRECTNESS), confidence: conf, review_reason: z.enum(ITEM_REVIEW_REASONS),
    what_student_did: z.string(), feedback: z.string(), teacher_note: z.string(),
  })),
  integrity: z.object({ grader_directed_text_found: z.boolean(), excerpt: z.string() }),
  unmatched_work: z.string(),
  overall_feedback: z.string(),
  teacher_summary: z.string(),
});
export type GradingOutput = z.infer<typeof GradingOutputSchema>;

export interface JsonSchemaOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

const formatCache = new WeakMap<z.ZodType, JsonSchemaOutputFormat>();

/**
 * The `output_config.format` for a schema. Built with zod's own converter rather than the SDK's
 * helper, because the helper moves `enum` into `description` and the enums would go unenforced (§0 fact 1).
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
