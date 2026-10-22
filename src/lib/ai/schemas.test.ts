import { describe, expect, it } from "vitest";
import { ANSWER_TYPES, CONFIDENCE, CORRECTNESS, DOCUMENT_MATCHES, KEY_QUESTION_KINDS, SCAN_PAGE_KINDS } from "@/lib/types";
import {
  JudgingOutputSchema, JudgingOutputWithoutNotesSchema, judgingWithEmptyNotes, KeyExtractionSchema, outputFormat,
  PacketReadingOutputSchema, ReadingOutputSchema, ScanPagesSchema,
} from "./schemas";

type Json = Record<string, unknown>;

/** Every (sub)schema reachable from the root, so property *names* are never mistaken for keywords. */
function nodes(schema: Json): Json[] {
  const children = [
    ...Object.values((schema.properties ?? {}) as Record<string, Json>),
    ...(schema.items ? [schema.items as Json] : []),
    ...((schema.anyOf ?? []) as Json[]),
  ];
  return [schema, ...children.flatMap(nodes)];
}

function at(schema: Json, path: string[]): Json {
  return path.reduce<Json>((node, key) => node[key] as Json, schema);
}

const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern",
  "minItems", "maxItems", "format", "$ref", "$defs"];

describe.each([
  ["KeyExtractionSchema", KeyExtractionSchema],
  ["ReadingOutputSchema", ReadingOutputSchema],
  ["PacketReadingOutputSchema", PacketReadingOutputSchema],
  ["JudgingOutputSchema", JudgingOutputSchema],
  ["JudgingOutputWithoutNotesSchema", JudgingOutputWithoutNotesSchema],
  ["ScanPagesSchema", ScanPagesSchema],
])("outputFormat(%s)", (_name, schema) => {
  const format = outputFormat(schema);

  it("is a json_schema format without a dialect URI or parse hook", () => {
    expect(format.type).toBe("json_schema");
    expect(JSON.stringify(format)).not.toContain("$ref");
    expect(format.schema.$schema).toBeUndefined();
    expect(format).not.toHaveProperty("parse");
  });

  it("uses no keywords the API rejects", () => {
    const all = nodes(format.schema);
    expect(all.length).toBeGreaterThan(5);
    for (const node of all) {
      for (const keyword of UNSUPPORTED) expect(Object.keys(node)).not.toContain(keyword);
    }
  });

  it("closes every object", () => {
    const objects = nodes(format.schema).filter((n) => n.type === "object");
    expect(objects.length).toBeGreaterThan(0);
    for (const node of objects) {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties as Json));
    }
  });

  it("is computed once", () => {
    expect(outputFormat(schema)).toBe(format);
  });
});

describe("enums survive the conversion", () => {
  it("in the key extraction schema", () => {
    const item = at(outputFormat(KeyExtractionSchema).schema, ["properties", "items", "items", "properties"]);
    expect(at(item, ["answer_type", "enum"])).toEqual([...ANSWER_TYPES]);
    expect(at(item, ["answer_source", "enum"])).toEqual(["key", "ai_proposed"]);
    expect(at(item, ["confidence", "enum"])).toEqual([...CONFIDENCE]);
    expect(at(outputFormat(KeyExtractionSchema).schema, ["properties", "document_kind", "enum"]))
      .toEqual(["answer_key", "blank_worksheet", "student_work", "unrelated"]);
  });

  it("in the key extraction schema's questions for the teacher", () => {
    const root = outputFormat(KeyExtractionSchema).schema;
    const question = at(root, ["properties", "questions_for_teacher", "items", "properties"]);
    expect(Object.keys(question)).toEqual(["id", "kind", "item_label", "question", "suggested_answer", "choices"]);
    expect(at(question, ["kind", "enum"])).toEqual([...KEY_QUESTION_KINDS]);
    expect(at(question, ["kind", "enum"])).toEqual(["missing_answer", "points", "partial_credit", "accept_equivalents", "ambiguous_item", "other"]);
    expect(at(question, ["item_label", "type"])).toEqual(["string", "null"]);
    expect(at(question, ["suggested_answer", "type"])).toEqual(["string", "null"]);
    expect(at(question, ["choices", "type"])).toBe("array");
    expect(at(question, ["choices", "items", "type"])).toBe("string");
    expect(at(root, ["properties", "suggested_title", "type"])).toEqual(["string", "null"]);
    // Generation order: the items first, the questions about them and the title last.
    expect(Object.keys(at(root, ["properties"]))).toEqual([
      "document_kind", "items", "stated_total_points", "notes", "questions_for_teacher", "suggested_title",
    ]);
  });

  it("requires the questions and title (null, never omitted)", () => {
    const base = {
      document_kind: "answer_key", items: [], stated_total_points: null, notes: "",
    };
    expect(KeyExtractionSchema.safeParse(base).success).toBe(false);
    expect(KeyExtractionSchema.safeParse({ ...base, questions_for_teacher: [], suggested_title: null }).success).toBe(true);
    expect(KeyExtractionSchema.safeParse({
      ...base, suggested_title: "Quiz 3",
      questions_for_teacher: [{ id: "q1", kind: "points", item_label: null, question: "Points?", suggested_answer: null, choices: [] }],
    }).success).toBe(true);
    expect(KeyExtractionSchema.safeParse({
      ...base, suggested_title: null,
      questions_for_teacher: [{ id: "q1", kind: "grade_level", item_label: null, question: "?", suggested_answer: null, choices: [] }],
    }).success).toBe(false);
  });

  it("in the reading and judging schemas", () => {
    const reading = outputFormat(ReadingOutputSchema).schema;
    expect(at(reading, ["properties", "document_check", "properties", "match", "enum"])).toEqual([...DOCUMENT_MATCHES]);
    expect(at(reading, ["properties", "items", "items", "properties", "reading_confidence", "enum"])).toEqual([...CONFIDENCE]);
    const judging = outputFormat(JudgingOutputSchema).schema;
    expect(at(judging, ["properties", "items", "items", "properties", "correctness", "enum"])).toEqual([...CORRECTNESS]);
  });

  it("in the scan pages schema", () => {
    const page = at(outputFormat(ScanPagesSchema).schema, ["properties", "pages", "items", "properties"]);
    expect(at(page, ["kind", "enum"])).toEqual([...SCAN_PAGE_KINDS]);
    expect(at(page, ["confidence", "enum"])).toEqual([...CONFIDENCE]);
    expect(Object.keys(page)).toEqual(["chunk_page", "kind", "starts_new_paper", "student_name", "section_raw", "page_marker",
      "worksheet_page", "confidence", "note"]);
  });

  it("renders nullable fields as a type union", () => {
    const root = outputFormat(ReadingOutputSchema).schema;
    expect(at(root, ["properties", "student", "properties", "name", "type"])).toEqual(["string", "null"]);
    const item = at(outputFormat(KeyExtractionSchema).schema, ["properties", "items", "items", "properties"]);
    expect(at(item, ["points", "type"])).toEqual(["number", "null"]);
    expect(at(item, ["group_points", "type"])).toEqual(["number", "null"]);
    const page = at(outputFormat(ScanPagesSchema).schema, ["properties", "pages", "items", "properties"]);
    for (const field of ["student_name", "section_raw", "page_marker"]) expect(at(page, [field, "type"])).toEqual(["string", "null"]);
    expect(at(page, ["worksheet_page", "type"])).toEqual(["number", "null"]);
    expect(at(page, ["chunk_page", "type"])).toBe("number");
  });
});

describe("the reading schema", () => {
  it("asks for what the student marked and how sure the reader is, and never for a judgment", () => {
    const root = outputFormat(ReadingOutputSchema).schema;
    expect(Object.keys(at(root, ["properties"]))).toEqual(["student", "document_check", "items", "integrity", "unmatched_work"]);
    expect(Object.keys(at(root, ["properties", "items", "items", "properties"]))).toEqual(["ref", "pages", "student_answer", "marks_seen",
      "legibility", "attempt", "reading_confidence"]);
    const json = JSON.stringify(outputFormat(ReadingOutputSchema));
    for (const word of ["correctness", "review_reason", "feedback", "expected"]) expect(json).not.toContain(word);
  });

  it("reads a chunk of a scan as papers with their boundaries, each read like one paper", () => {
    const paper = at(outputFormat(PacketReadingOutputSchema).schema, ["properties", "papers", "items", "properties"]);
    expect(Object.keys(paper)).toEqual(["first_page", "last_page", "continues_from_previous_chunk", "may_continue_after_chunk",
      "boundary_confidence", "student", "document_check", "items", "integrity", "unmatched_work"]);
    expect(at(paper, ["items"])).toEqual(at(outputFormat(ReadingOutputSchema).schema, ["properties", "items"]));
  });
});

describe("the judging schema without notes", () => {
  const lean = outputFormat(JudgingOutputWithoutNotesSchema).schema;
  const full = outputFormat(JudgingOutputSchema).schema;

  it("asks for every judgment and no note", () => {
    expect(Object.keys(at(lean, ["properties"]))).toEqual(["items"]);
    expect(Object.keys(at(lean, ["properties", "items", "items", "properties"]))).toEqual(["ref", "attempt", "correctness", "confidence",
      "review_reason"]);
    expect(Object.keys(at(full, ["properties", "items", "items", "properties"])).slice(-3))
      .toEqual(["what_student_did", "feedback", "teacher_note"]);
    expect(Object.keys(at(full, ["properties"]))).toEqual(["items", "overall_feedback", "teacher_summary"]);
  });

  it("fills in empty notes, keeping every judgment", () => {
    const judged = { ref: "Q2", attempt: "complete" as const, correctness: "incorrect" as const, confidence: "high" as const, review_reason: "none" as const };
    expect(JudgingOutputSchema.parse(judgingWithEmptyNotes({ items: [judged] }))).toEqual({
      items: [{ ...judged, what_student_did: "", feedback: "", teacher_note: "" }],
      overall_feedback: "",
      teacher_summary: "",
    });
  });
});
