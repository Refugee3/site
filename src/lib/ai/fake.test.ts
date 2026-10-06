import { describe, expect, it } from "vitest";
import { AiError } from "./errors";
import { createFakeGrader } from "./fake";
import type { GradeInput } from "./grader";
import { GradingOutputSchema, KeyExtractionSchema } from "./schemas";
import { makeKeyItem, makeSection } from "./test-utils";

const grader = createFakeGrader({ delayMs: 0 });

function gradeInput(studentPdf: Uint8Array, itemCount = 5, sections = [makeSection({ label: "Period 1" }),
  makeSection({ id: "s2", label: "Period 2", canonicalKey: "2", sortOrder: 1 })]): GradeInput {
  return {
    assignment: { title: "Quiz", instructions: "" },
    teacherNotes: "",
    sections,
    items: Array.from({ length: itemCount }, (_, i) => makeKeyItem({ id: `item-${i}`, label: String(i + 1), position: i })),
    keyPdf: null,
    studentPdf,
    studentPageCount: 3,
  };
}

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7 ${text}`);

describe("fake grader", () => {
  it("grades the same paper the same way every time", async () => {
    const first = await grader.gradeSubmission(gradeInput(pdf("alice")));
    const again = await createFakeGrader({ delayMs: 0 }).gradeSubmission(gradeInput(pdf("alice")));
    expect(again.output).toEqual(first.output);
  });

  it("grades different papers differently", async () => {
    const a = await grader.gradeSubmission(gradeInput(pdf("alice"), 30));
    const b = await grader.gradeSubmission(gradeInput(pdf("bob"), 30));
    expect(b.output.items.map((i) => i.correctness)).not.toEqual(a.output.items.map((i) => i.correctness));
  });

  it("returns schema-valid output with one entry per ref and fake metadata", async () => {
    const result = await grader.gradeSubmission(gradeInput(pdf("carol"), 4));
    expect(GradingOutputSchema.parse(result.output)).toEqual(result.output);
    expect(result.refs).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(result.output.items.map((i) => i.ref)).toEqual(result.refs);
    expect(result.keyPdfIncluded).toBe(false);
    expect(grader.mode).toBe("fake");
    expect(result.meta).toMatchObject({
      requestedModel: "fake", servedModel: "fake", fallbackUsed: false, stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("produces internally consistent judgments across the outcome mix", async () => {
    const { output } = await grader.gradeSubmission(gradeInput(pdf("class"), 400));
    const share = (pred: (i: (typeof output.items)[number]) => boolean) => output.items.filter(pred).length / output.items.length;
    expect(share((i) => i.correctness === "correct")).toBeGreaterThan(0.5);
    expect(share((i) => i.correctness === "correct")).toBeLessThan(0.7);
    expect(share((i) => i.attempt === "none")).toBeGreaterThan(0.05);
    expect(share((i) => i.correctness === "cannot_judge")).toBeGreaterThan(0.01);
    expect(share((i) => i.confidence === "low")).toBeGreaterThan(0.06);
    for (const item of output.items) {
      expect(item.attempt === "none").toBe(item.correctness === "no_answer");
      expect(item.student_answer === "").toBe(item.attempt === "none"); // never trips reconcile's empty-answer repair
      expect(item.pages.every((p) => p >= 1 && p <= 3)).toBe(true);
      expect(item.what_student_did).toContain(item.ref);
    }
  });

  it("reads names and sections from the class list, sometimes missing", async () => {
    const papers = await Promise.all(Array.from({ length: 60 }, (_, i) => grader.gradeSubmission(gradeInput(pdf(`paper ${i}`), 1))));
    const students = papers.map((p) => p.output.student);
    expect(students.some((s) => s.name === null)).toBe(true);
    const names = students.flatMap((s) => (s.name === null ? [] : [s.name]));
    // Letters only: the board's name key ignores digits, so a digit tag would merge different fake students.
    expect(names.every((name) => /^Test Student [A-P][a-p]{3}$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(students.some((s) => s.section_raw === null)).toBe(true);
    for (const s of students) {
      expect([null, "Period 1", "Period 2"]).toContain(s.section_raw);
      expect(s.section_match).toBe(s.section_raw);
    }
  });

  it("reports no section when none are configured", async () => {
    const { output } = await grader.gradeSubmission(gradeInput(pdf("dave"), 1, []));
    expect(output.student.section_raw).toBeNull();
    expect(output.student.section_match).toBeNull();
  });

  it("extracts the six sample items", async () => {
    const { output, meta } = await grader.extractKey({ assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf("key"), pageCount: 1 });
    expect(KeyExtractionSchema.parse(output)).toEqual(output);
    expect(output.document_kind).toBe("answer_key");
    expect(output.items.map((i) => [i.label, i.group_label, i.answer_type])).toEqual([
      ["1", "", "multiple_choice"],
      ["2", "", "numeric"],
      ["3a", "3", "short_answer"],
      ["3b", "3", "short_answer"],
      ["4", "", "diagram"],
      ["5", "", "long_answer"],
    ]);
    expect(output.items[4]).toMatchObject({ answer_source: "ai_proposed", confidence: "low" });
    expect(output.items.every((i) => i.page === 1)).toBe(true);
    expect(meta.servedModel).toBe("fake");
  });

  it("rejects with a retryable abort when the signal fires", async () => {
    const aborted = AbortSignal.abort();
    await expect(grader.gradeSubmission(gradeInput(pdf("eve")), { signal: aborted }))
      .rejects.toMatchObject({ code: "aborted", o: { retryable: true } });

    const controller = new AbortController();
    const pending = createFakeGrader({ delayMs: 60_000 }).extractKey(
      { assignmentTitle: "Quiz", teacherNotes: "", keyPdf: pdf("key"), pageCount: 1 },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AiError);
  });
});
