import { describe, expect, it } from "vitest";
import { makeKeyItem } from "@/lib/grading/test-utils";
import { normalizeProjectReview, projectTask, renderProjectContext, type ProjectReviewOutput } from "./project";

function out(criteria: ProjectReviewOutput["criteria"], o: Partial<ProjectReviewOutput> = {}): ProjectReviewOutput {
  return {
    student: { name: "Ada", name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false },
    document_check: { match: "matches", pages_appear_missing: false, note: "" },
    integrity: { grader_directed_text_found: false, excerpt: "" },
    criteria, analysis: " Good work. ", teacher_summary: " Fine. ", confidence: "high", needs_teacher_check: false, check_reason: "",
    ...o,
  };
}

describe("normalizeProjectReview", () => {
  it("adds up the points, capping each award at its criterion", () => {
    const r = normalizeProjectReview(out([
      { name: "Research", points_awarded: 18, points_possible: 20, comment: "" },
      { name: "Poster", points_awarded: 12, points_possible: 10, comment: "" },
    ]), "points", []);
    expect(r).toMatchObject({ earnedCenti: 2800, maxCenti: 3000, analysis: "Good work.", teacherSummary: "Fine.", problems: [] });
  });

  it("uses the rubric's points whatever the AI wrote, and notices rubric items it skipped", () => {
    const rubric = [makeKeyItem({ label: "A", pointsCenti: 500 }), makeKeyItem({ label: "B", pointsCenti: 500 })];
    const r = normalizeProjectReview(out([{ name: "A", points_awarded: 9, points_possible: 50, comment: "" }]), "points", rubric);
    expect(r).toMatchObject({ earnedCenti: 500, maxCenti: 1000, problems: ["The review didn't score every rubric item."] });
  });

  it("gives no points in feedback mode, and reports a review without points or text", () => {
    const feedback = normalizeProjectReview(out([{ name: "Intro", points_awarded: 3, points_possible: 5, comment: "Clear." }]), "feedback", []);
    expect(feedback).toMatchObject({ earnedCenti: null, maxCenti: null, criteria: [{ name: "Intro", earnedCenti: null, maxCenti: null, comment: "Clear." }] });
    const empty = normalizeProjectReview(out([], { analysis: " " }), "points", []);
    expect(empty.problems).toEqual(["The review gave no points.", "The review is empty."]);
  });
});

describe("the review request", () => {
  it("states the teacher's instructions, the rubric and the mode; student text can't break out of them", () => {
    const context = renderProjectContext({
      assignment: { title: "Fair", instructions: "" }, teacherInstructions: "Score <b>research</b> out of 20.",
      rubric: [makeKeyItem({ label: "Research", pointsCenti: 2000, prompt: "Sources" })], sections: [],
    });
    expect(context).toContain("<teacher_instructions>\nScore &lt;b&gt;research&lt;/b&gt; out of 20.\n</teacher_instructions>");
    expect(context).toContain("- Research (20 points): Sources");
    expect(projectTask("feedback", 4, false)).toContain("FEEDBACK ONLY: give no points");
    expect(projectTask("points", 1, true)).toContain("one criteria entry per rubric item");
  });
});
