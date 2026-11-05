import { describe, expect, it } from "vitest";
import type { GradingOutput } from "@/lib/ai/schemas";
import { reconcileGrading } from "@/lib/grading/reconcile";
import type { Section } from "@/lib/types";
import { matchRoster, nameScore, parseRoster, rosterToText } from "./roster";

const ROSTER = parseRoster(`
# Period 3 and 4
Maria Lopez | Period 3
James Brown | Period 4
Wei Chen
Aisha Khan\tPeriod 3
José Álvarez | Period 4
maria lopez
`);

describe("the class list", () => {
  it("parses one student per line, with an optional section after a bar or a tab; comments and repeats are skipped", () => {
    expect(ROSTER).toEqual([
      { name: "Maria Lopez", section: "Period 3" },
      { name: "James Brown", section: "Period 4" },
      { name: "Wei Chen", section: null },
      { name: "Aisha Khan", section: "Period 3" },
      { name: "José Álvarez", section: "Period 4" },
    ]);
    expect(rosterToText(ROSTER).split("\n")[0]).toBe("Maria Lopez | Period 3");
    expect(parseRoster(rosterToText(ROSTER))).toEqual(ROSTER);
  });
});

describe("matching a name read on a paper to the class list", () => {
  const match = (read: string | null, roster = ROSTER) => {
    const m = matchRoster(read, roster);
    return m.kind === "match" ? m.entry.name : m.kind === "ambiguous" ? m.candidates.map((c) => c.name) : null;
  };

  it("takes a misspelt reading as the student it clearly is", () => {
    expect(match("Mria Lopes")).toBe("Maria Lopez");
    expect(match("Jmes Brwn")).toBe("James Brown");
    expect(match("MARIA LOPEZ")).toBe("Maria Lopez");
  });

  it("ignores accents, word order, a comma and initials", () => {
    expect(match("Jose Alvarez")).toBe("José Álvarez");
    expect(match("Lopez, Maria")).toBe("Maria Lopez");
    expect(match("Chen Wei")).toBe("Wei Chen");
    expect(match("M. Lopez")).toBe("Maria Lopez");
    expect(match("J Brown")).toBe("James Brown");
  });

  it("takes a first name alone when only one student has it", () => {
    expect(match("Aisha")).toBe("Aisha Khan");
    expect(match("Wei")).toBe("Wei Chen");
  });

  it("two similar names make the reading ambiguous; a name on no list is no match", () => {
    const twins = parseRoster("John Smith\nJon Smyth\nMaria Lopez\nMaria Garcia");
    expect(match("Jon Smith", twins)).toEqual(["Jon Smyth", "John Smith"]);
    expect(match("Maria", twins)).toEqual(["Maria Lopez", "Maria Garcia"]);
    expect(match("Zoe Park")).toBeNull();
    expect(match("")).toBeNull();
    expect(match(null)).toBeNull();
    expect(match("Maria Lopez", [])).toBeNull();
  });

  it("scores the share of the reading explained and of the name covered", () => {
    expect(nameScore(["maria", "lopez"], ["maria", "lopez"])).toBe(1);
    expect(nameScore(["maria"], ["maria", "lopez"])).toBe(0.75);
    expect(nameScore(["zoe"], ["maria", "lopez"])).toBe(0);
  });
});

describe("the class list in a paper's grading (reconcile)", () => {
  const sections: Section[] = [
    { id: "p3", assignmentId: "a", label: "Period 3", aliases: [], canonicalKey: "3", sortOrder: 0 },
    { id: "p4", assignmentId: "a", label: "Period 4", aliases: [], canonicalKey: "4", sortOrder: 1 },
  ];
  const output = (name: string | null, confidence: "high" | "medium" | "low" = "high", section: string | null = null): GradingOutput => ({
    student: { name, name_confidence: confidence, section_raw: section, section_match: null, multiple_students_detected: false },
    document_check: { match: "matches", pages_appear_missing: false, note: "" },
    items: [{
      ref: "Q1", pages: [1], student_answer: "B", legibility: "clear", attempt: "complete", correctness: "correct", confidence: "high",
      review_reason: "none", what_student_did: "", feedback: "", teacher_note: "",
    }],
    integrity: { grader_directed_text_found: false, excerpt: "" },
    unmatched_work: "",
    overall_feedback: "",
    teacher_summary: "",
  });
  const current = { studentName: null, nameSource: null, nameKey: null, nameSortKey: "~", sectionId: null, sectionSource: null };
  const reconcile = (o: GradingOutput, roster = ROSTER) => reconcileGrading({
    output: o, refs: ["Q1"], items: [{ id: "i1", label: "1" }], sections, pageCount: 1, current, fallbackUsed: false, roster,
  });

  it("uses the list's spelling and section, keeps the reading, and raises no name flag even for a hard-to-read name", () => {
    const r = reconcile(output("Mria Lopes", "low"));
    expect(r.fields).toMatchObject({ studentName: "Maria Lopez", aiName: "Mria Lopes", rosterName: "Maria Lopez", sectionId: "p3", nameSource: "ai" });
    expect(r.fields.flags).toEqual([]);
    expect(r.status).toBe("graded");
  });

  it("the section written on the paper comes first", () => {
    expect(reconcile(output("Maria Lopez", "high", "Period 4")).fields.sectionId).toBe("p4");
  });

  it("an ambiguous or unknown reading keeps the reading and is flagged for a check", () => {
    const twins = parseRoster("Maria Lopez | Period 3\nMaria Garcia | Period 3");
    const ambiguous = reconcile(output("Maria"), twins);
    expect(ambiguous.fields).toMatchObject({ studentName: "Maria", rosterName: null });
    expect(ambiguous.fields.flags).toContain("name_uncertain");
    expect(ambiguous.fields.teacherSummary).toMatch(/could be Maria Lopez or Maria Garcia/);
    const unknown = reconcile(output("Zoe Park"));
    expect(unknown.fields).toMatchObject({ studentName: "Zoe Park", rosterName: null });
    expect(unknown.fields.flags).toContain("name_uncertain");
    expect(unknown.fields.teacherSummary).toMatch(/matches no one on your class list/);
    expect(reconcile(output(null)).fields.flags).toContain("name_missing");
  });

  it("without a class list nothing changes", () => {
    const r = reconcileGrading({
      output: output("Mria Lopes"), refs: ["Q1"], items: [{ id: "i1", label: "1" }], sections, pageCount: 1, current, fallbackUsed: false,
    });
    expect(r.fields.studentName).toBe("Mria Lopes");
    expect("rosterName" in r.fields).toBe(false);
  });
});
