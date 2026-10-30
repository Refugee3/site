import { beforeEach, describe, expect, it } from "vitest";
import { createFakeGrader } from "@/lib/ai/fake";
import type { ProjectReviewOutput } from "@/lib/ai/project";
import { setClockForTests } from "@/lib/clock";
import { getAssignment, updateAssignment } from "@/lib/db/repos/assignments";
import { getKey, updateKey } from "@/lib/db/repos/keys";
import { getSubmission } from "@/lib/db/repos/submissions";
import { drainQueue, FAKE_META, scriptedGrader } from "@/lib/jobs/test-utils";
import { createProject, updateAssignment as updateAssignmentForm } from "@/lib/services/assignments";
import { saveKey } from "@/lib/services/keys";
import { ingestTeacherUpload, setTotalOverride } from "@/lib/services/submissions";
import type { Assignment } from "@/lib/types";
import { makePdf, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";

let project: Assignment;

beforeEach(() => {
  setClockForTests(() => 1_700_000_000_000);
  useTestDb();
  project = seedAssignment(seedTeacher().id, { kind: "project", projectMode: "points", title: "Science fair" });
});

async function upload(): Promise<string> {
  return (await ingestTeacherUpload(project, [{ filename: "p.pdf", bytes: await makePdf(3) }])).submissionId;
}

function review(o: Partial<ProjectReviewOutput> = {}): ProjectReviewOutput {
  return {
    student: { name: "Ada Park", name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false },
    document_check: { match: "matches", pages_appear_missing: false, note: "" },
    integrity: { grader_directed_text_found: false, excerpt: "" },
    criteria: [
      { name: "Hypothesis", points_awarded: 8, points_possible: 10, comment: "Clear." },
      { name: "Data", points_awarded: 12, points_possible: 10, comment: "Over the top." },
    ],
    analysis: "Strong hypothesis; the data section needs units.",
    teacher_summary: "Good project.",
    confidence: "high",
    needs_teacher_check: false,
    check_reason: "",
    ...o,
  };
}

describe("projects", () => {
  it("are stored as projects with their mode", () => {
    expect(getAssignment(project.id)).toMatchObject({ kind: "project", projectMode: "points" });
    expect(updateAssignment(project.id, { kind: "quiz" })).toMatchObject({ kind: "quiz", projectMode: null });
    expect(updateAssignment(project.id, { kind: "project", projectMode: "feedback" })).toMatchObject({ kind: "project", projectMode: "feedback" });
  });

  it("need instructions (or an approved rubric) before papers can be uploaded, but no answer key", async () => {
    await expect(upload()).rejects.toMatchObject({ code: "key_not_ready" });
    updateKey(project.id, { teacherNotes: "Score the hypothesis (10) and the data (10)." });
    await expect(upload()).resolves.toEqual(expect.any(String));
  });

  it("are reviewed as a whole and scored from the review, each award capped at its points", async () => {
    updateKey(project.id, { teacherNotes: "Score the hypothesis (10) and the data (10)." });
    const id = await upload();
    const sent: string[] = [];
    await drainQueue(scriptedGrader({
      async reviewProject(input) {
        sent.push(`${input.mode}|${input.teacherInstructions}|${input.rubric.length}`);
        return { output: review(), meta: FAKE_META };
      },
    }));

    expect(sent).toEqual(["points|Score the hypothesis (10) and the data (10).|0"]);
    expect(getSubmission(id)).toMatchObject({
      status: "graded", studentName: "Ada Park", overallFeedback: "Strong hypothesis; the data section needs units.",
      scoreEarnedCenti: 1800, scoreMaxCenti: 2000,
      projectReview: { mode: "points", earnedCenti: 1800, maxCenti: 2000, criteria: [
        { name: "Hypothesis", earnedCenti: 800, maxCenti: 1000, comment: "Clear." },
        { name: "Data", earnedCenti: 1000, maxCenti: 1000, comment: "Over the top." },
      ] },
    });

    setTotalOverride(getSubmission(id)!, 1500);
    expect(getSubmission(id)).toMatchObject({ scoreEarnedCenti: 1500, scoreMaxCenti: 2000 });
  });

  it("give no score in feedback mode, only the write-up", async () => {
    updateAssignment(project.id, { projectMode: "feedback" });
    project = getAssignment(project.id)!;
    updateKey(project.id, { teacherNotes: "Analyze each section: what works and what doesn't." });
    const id = await upload();
    await drainQueue(createFakeGrader({ delayMs: 0 }));

    const paper = getSubmission(id)!;
    expect(paper).toMatchObject({ status: "graded", scoreEarnedCenti: null, scoreMaxCenti: null, projectReview: { mode: "feedback", earnedCenti: null } });
    expect(paper.overallFeedback).toContain("Practice analysis");
    expect(paper.projectReview!.criteria.every((c) => c.maxCenti === null && c.earnedCenti === null)).toBe(true);
  });

  it("score a rubric's items with the rubric's points, and flag a review that is unsure or misses items", async () => {
    saveKey(project, {
      teacherNotes: "", acknowledgeAiProposed: false,
      items: ["Research", "Poster"].map((label) => ({
        id: null, label, groupLabel: "", prompt: "", answerType: "long_answer" as const, expectedAnswer: "", acceptableAnswers: [],
        gradingCriteria: "", pointsCenti: 500, partialCredit: true, page: null,
      })),
    });
    const id = await upload();
    await drainQueue(scriptedGrader({
      async reviewProject() {
        return {
          output: review({ criteria: [{ name: "Research", points_awarded: 4, points_possible: 99, comment: "" }], needs_teacher_check: true, check_reason: "Page 3 is blurry." }),
          meta: FAKE_META,
        };
      },
    }));

    const paper = getSubmission(id)!;
    expect(paper).toMatchObject({ status: "needs_review", scoreEarnedCenti: 400, scoreMaxCenti: 1000 });
    expect(paper.flags).toContain("low_confidence");
    expect(paper.teacherSummary).toContain("Page 3 is blurry.");
    expect(paper.teacherSummary).toContain("The review didn't score every rubric item.");
  });

  it("start from the dashboard with instructions alone, or need a rubric when there are none", async () => {
    const teacher = seedTeacher({ email: "b@example.com" });
    await expect(createProject(teacher.id, { files: [], instructions: "  ", mode: "points" })).rejects.toMatchObject({ code: "validation" });
    const created = await createProject(teacher.id, { files: [], instructions: " Analyze each section. ", mode: "feedback" });
    expect(created).toMatchObject({ kind: "project", projectMode: "feedback", title: "Untitled project" });
    expect(getKey(created.id)).toMatchObject({ status: "empty", teacherNotes: "Analyze each section." });
  });

  it("mark reviewed projects for another review when switched between points and feedback", async () => {
    updateKey(project.id, { teacherNotes: "Score it out of 20." });
    const id = await upload();
    await drainQueue(createFakeGrader({ delayMs: 0 }));
    expect(getSubmission(id)!.gradedKeyRevision).toBe(getKey(project.id)!.revision);

    updateAssignmentForm(project, {
      title: project.title, kind: "project", projectMode: "feedback", instructions: "", gradingMode: "completion", accuracyWeight: 50,
      sectionsText: "", maxSubmissions: 500, writeNotes: false,
    });
    expect(getSubmission(id)!.gradedKeyRevision).toBeLessThan(getKey(project.id)!.revision);
    expect(getSubmission(id)).toMatchObject({ scoreEarnedCenti: null, scoreMaxCenti: null });
  });
});
