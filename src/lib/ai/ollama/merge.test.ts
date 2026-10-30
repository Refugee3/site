import { describe, expect, it } from "vitest";
import type { ReadingOutput } from "../schemas";
import { itemsInRefOrder, mergeReadings, pageBatches, previousFrom, refProblems } from "./merge";

const item = (ref: string, o: Partial<ReadingOutput["items"][number]> = {}): ReadingOutput["items"][number] => ({
  ref, pages: [1], student_answer: "4", marks_seen: "", legibility: "clear", attempt: "complete", reading_confidence: "high", ...o,
});

const grading = (items: ReadingOutput["items"], o: Partial<ReadingOutput> = {}): ReadingOutput => ({
  student: { name: null, name_confidence: "low", section_raw: null, section_match: null, multiple_students_detected: false },
  document_check: { match: "matches", pages_appear_missing: false, note: "" },
  items, integrity: { grader_directed_text_found: false, excerpt: "" }, unmatched_work: "", ...o,
});

describe("pageBatches", () => {
  it("cuts pages into consecutive batches of at most `size`", () => {
    expect(pageBatches(9, 4)).toEqual([[1, 4], [5, 8], [9, 9]]);
    expect(pageBatches(4, 4)).toEqual([[1, 4]]);
    expect(pageBatches(1, 8)).toEqual([[1, 1]]);
    expect(pageBatches(0, 4)).toEqual([]);
  });
});

describe("itemsInRefOrder and refProblems", () => {
  it("keeps the first entry of each known ref, in key order, accepting [q1]-style refs", () => {
    const out = itemsInRefOrder(grading([item("Q3"), item("[q1]"), item("Q1", { student_answer: "dup" }), item("Q7")]), ["Q1", "Q2", "Q3"]);
    expect(out.items.map((i) => [i.ref, i.student_answer])).toEqual([["Q1", "4"], ["Q3", "4"]]);
    expect(refProblems(out, ["Q1", "Q2", "Q3"])).toEqual(["items must have exactly 3 entries, with ref Q1 to Q3 in this order", "missing: Q2"]);
    expect(refProblems(grading([item("Q1")]), ["Q1"])).toEqual([]);
  });
});

describe("mergeReadings", () => {
  it("takes each ref from the batch where the student did the most, and combines the rest", () => {
    const none = { attempt: "none" as const, legibility: "no_writing" as const, pages: [] as number[] };
    const merged = mergeReadings([
      grading([item("Q1", { pages: [1] }), item("Q2", none), item("Q3", { attempt: "partial", pages: [2] })], {
        document_check: { match: "matches", pages_appear_missing: false, note: "Page 1 is faint." },
      }),
      grading([item("Q1", none), item("Q2", { pages: [3] }), item("Q3", { pages: [3], reading_confidence: "low" })], {
        student: { name: "Ana", name_confidence: "high", section_raw: "P3", section_match: null, multiple_students_detected: false },
        document_check: { match: "uncertain", pages_appear_missing: true, note: "Page 1 is faint." },
        unmatched_work: "A doodle.",
      }),
    ], ["Q1", "Q2", "Q3"]);
    expect(merged.items.map((i) => [i.ref, i.pages, i.attempt])).toEqual([["Q1", [1], "complete"], ["Q2", [3], "complete"], ["Q3", [3], "complete"]]);
    expect(merged.student.name).toBe("Ana");
    expect(merged.document_check).toEqual({ match: "matches", pages_appear_missing: true, note: "Page 1 is faint." });
    expect(merged).toMatchObject({ unmatched_work: "A doodle." });
  });

  it("returns a single batch as it is", () => {
    const only = grading([item("Q1")]);
    expect(mergeReadings([only], ["Q1"])).toBe(only);
  });
});

describe("previousFrom", () => {
  it("describes the last page read, as a scan page", () => {
    expect(previousFrom([{
      chunk_page: 4, kind: "student_work", starts_new_paper: false, student_name: "Ana", section_raw: null, page_marker: "2/2",
      worksheet_page: 2, confidence: "high", note: "",
    }], 21)).toEqual({ page: 24, kind: "student_work", studentName: "Ana", worksheetPage: 2, pageMarker: "2/2" });
    expect(previousFrom([], 1)).toBeNull();
  });
});
