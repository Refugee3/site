import { describe, expect, it } from "vitest";
import { ANSWER_TYPES, CONFIDENCE, CORRECTNESS, DOCUMENT_MATCHES, SCAN_PAGE_KINDS } from "@/lib/types";
import { GradingOutputSchema, KeyExtractionSchema, outputFormat, ScanPagesSchema } from "./schemas";

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
  ["GradingOutputSchema", GradingOutputSchema],
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
    expect(all.length).toBeGreaterThan(10);
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

  it("in the grading schema", () => {
    const root = outputFormat(GradingOutputSchema).schema;
    expect(at(root, ["properties", "items", "items", "properties", "correctness", "enum"])).toEqual([...CORRECTNESS]);
    expect(at(root, ["properties", "document_check", "properties", "match", "enum"])).toEqual([...DOCUMENT_MATCHES]);
  });

  it("in the scan pages schema", () => {
    const page = at(outputFormat(ScanPagesSchema).schema, ["properties", "pages", "items", "properties"]);
    expect(at(page, ["kind", "enum"])).toEqual([...SCAN_PAGE_KINDS]);
    expect(at(page, ["confidence", "enum"])).toEqual([...CONFIDENCE]);
    expect(Object.keys(page)).toEqual(["chunk_page", "kind", "starts_new_paper", "student_name", "section_raw", "page_marker",
      "worksheet_page", "confidence", "note"]);
  });

  it("renders nullable fields as a type union", () => {
    const root = outputFormat(GradingOutputSchema).schema;
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
