import { describe, expect, it } from "vitest";
import { ANSWER_TYPES, CONFIDENCE, CORRECTNESS, DOCUMENT_MATCHES } from "@/lib/types";
import { GradingOutputSchema, KeyExtractionSchema, outputFormat } from "./schemas";

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

  it("renders nullable fields as a type union", () => {
    const root = outputFormat(GradingOutputSchema).schema;
    expect(at(root, ["properties", "student", "properties", "name", "type"])).toEqual(["string", "null"]);
    const item = at(outputFormat(KeyExtractionSchema).schema, ["properties", "items", "items", "properties"]);
    expect(at(item, ["points", "type"])).toEqual(["number", "null"]);
    expect(at(item, ["group_points", "type"])).toEqual(["number", "null"]);
  });
});
