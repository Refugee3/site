import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getAssignment, listSections } from "@/lib/db/repos/assignments";
import { getKey } from "@/lib/db/repos/keys";
import { getSubmission, getSubmissionByReceipt } from "@/lib/db/repos/submissions";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { answeringGrader, drainQueue } from "@/lib/jobs/test-utils";
import {
  AssignmentFormSchema, createAssignment, defaultSectionsText, deleteAssignment, rotateShareCode, setAssignmentStatus,
  setFeedbackReleased, updateAssignment,
} from "@/lib/services/assignments";
import { setStudentUploads } from "@/lib/services/settings";
import { ingestStudentUpload, updateIdentity } from "@/lib/services/submissions";
import type { Assignment, AssignmentFormInput, Submission, Teacher } from "@/lib/types";
import { enableStudentUploads, makePdf, seedApprovedKey, seedTeacher, useTestDb } from "@/test/helpers";

const T0 = 1_700_000_000_000;
let teacher: Teacher;

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
  enableStudentUploads();
  teacher = seedTeacher();
});

function form(o: Partial<AssignmentFormInput> = {}): AssignmentFormInput {
  return {
    title: "Unit 4 Quiz", instructions: "", gradingMode: "completion", accuracyWeight: 50, sectionsText: "", maxSubmissions: 500, ...o,
  };
}

/** An open assignment with an approved two-item key and one graded paper (both answers attempted, item 1 wrong). */
async function withGradedPaper(o: Partial<AssignmentFormInput> = {}): Promise<{ assignment: Assignment; paper: Submission }> {
  const assignment = createAssignment(teacher.id, form(o));
  seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2", pointsCenti: 200 }]);
  const open = setAssignmentStatus(assignment, "open");
  const { receiptUrl } = await ingestStudentUpload(open.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1) }]);
  await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, {
    student: { section_raw: "P3", section_match: null },
    items: [makeOutputItem(refs[0], { correctness: "incorrect" }), makeOutputItem(refs[1])],
  })));
  return { assignment: open, paper: getSubmissionByReceipt(receiptUrl.slice("/r/".length))! };
}

describe("AssignmentFormSchema", () => {
  it("coerces FormData strings and fills defaults", () => {
    const parsed = AssignmentFormSchema.parse({ title: "  Quiz 1 ", accuracyWeight: "40", maxSubmissions: "30" });
    expect(parsed).toEqual({
      title: "Quiz 1", instructions: "", gradingMode: "completion", accuracyWeight: 40, sectionsText: "", maxSubmissions: 30,
    });
  });

  it("rejects bad values field by field", () => {
    const result = AssignmentFormSchema.safeParse({
      title: " ", gradingMode: "vibes", accuracyWeight: "42", maxSubmissions: "0", sectionsText: "Period 3\nP3",
    });
    expect(result.success).toBe(false);
    const fields = new Set(result.error!.issues.map((issue) => issue.path.join(".")));
    expect(fields).toEqual(new Set(["title", "gradingMode", "accuracyWeight", "maxSubmissions", "sectionsText"]));
  });

  it("allows at most 50 sections", () => {
    const sectionsText = Array.from({ length: 51 }, (_, i) => `Period ${i + 1}`).join("\n");
    expect(AssignmentFormSchema.safeParse({ title: "Quiz", sectionsText }).success).toBe(false);
  });
});

describe("createAssignment", () => {
  it("creates a draft with an empty key, its sections and a share code", () => {
    const a = createAssignment(teacher.id, form({ sectionsText: "Period 1 | P1, 1st\nPeriod 3" }));

    expect(a).toMatchObject({ status: "draft", title: "Unit 4 Quiz", shareCode: expect.stringMatching(/^[2-9A-HJKMNP-Z]{6}$/) });
    expect(getKey(a.id)).toMatchObject({ status: "empty", revision: 0 });
    expect(listSections(a.id).map((s) => [s.label, s.aliases])).toEqual([["Period 1", ["P1", "1st"]], ["Period 3", []]]);
    expect(defaultSectionsText(teacher.id)).toBe("Period 1 | P1, 1st\nPeriod 3");
  });

  it("refuses an invalid sections list even when the schema was bypassed", () => {
    expect(() => createAssignment(teacher.id, form({ sectionsText: "Period 3\nP3" })))
      .toThrow(expect.objectContaining({ code: "validation", extra: { fieldErrors: { sectionsText: [expect.any(String)] } } }));
  });
});

describe("updateAssignment", () => {
  it("rescores every paper when the grading mode changes, without an AI call", async () => {
    const { assignment, paper } = await withGradedPaper();
    expect(paper.scoreEarnedCenti).toBe(300);

    updateAssignment(assignment, form({ gradingMode: "accuracy" }));
    expect(getSubmission(paper.id)!.scoreEarnedCenti).toBe(200);

    updateAssignment(assignment, form({ gradingMode: "blended", accuracyWeight: 50 }));
    expect(getSubmission(paper.id)!.scoreEarnedCenti).toBe(250);
  });

  it("re-matches the sections papers wrote when the section list changes", async () => {
    const { assignment, paper } = await withGradedPaper({ sectionsText: "Period 1\nPeriod 2" });
    expect(getSubmission(paper.id)).toMatchObject({ sectionId: null, status: "needs_review", flags: ["section_unmatched"] });

    updateAssignment(assignment, form({ sectionsText: "Period 1\nPeriod 2\nPeriod 3" }));

    const period3 = listSections(assignment.id)[2];
    expect(getSubmission(paper.id)).toMatchObject({ sectionId: period3.id, sectionSource: "ai", status: "graded", flags: [] });
  });

  describe("papers whose identity the teacher confirmed", () => {
    const sectionNamed = (a: Assignment, label: string) => listSections(a.id).find((section) => section.label === label)!;

    it("are placed again when their section is renamed to a new spelling", async () => {
      const { assignment, paper } = await withGradedPaper({ sectionsText: "Peroid 3\nPeriod 4" });
      updateIdentity(getSubmission(paper.id)!, { studentName: "Maria Lopez", sectionId: sectionNamed(assignment, "Peroid 3").id });

      updateAssignment(assignment, form({ sectionsText: "Period 3\nPeriod 4" }));

      expect(getSubmission(paper.id)).toMatchObject({
        sectionId: sectionNamed(assignment, "Period 3").id, sectionSource: "ai", nameSource: "teacher", status: "graded", flags: [],
      });
    });

    it("are flagged for review when their section is gone and nothing else matches", async () => {
      const { assignment, paper } = await withGradedPaper({ sectionsText: "Peroid 3\nPeriod 4" });
      updateIdentity(getSubmission(paper.id)!, { studentName: "Maria Lopez", sectionId: sectionNamed(assignment, "Peroid 3").id });

      updateAssignment(assignment, form({ sectionsText: "Biology\nPeriod 4" }));

      expect(getSubmission(paper.id)).toMatchObject({
        sectionId: null, sectionSource: null, status: "needs_review", flags: ["section_unmatched"],
      });
    });

    it("keep a section the teacher chose while it still exists", async () => {
      const { assignment, paper } = await withGradedPaper({ sectionsText: "Period 3\nPeriod 4" });
      const period4 = sectionNamed(assignment, "Period 4");
      updateIdentity(getSubmission(paper.id)!, { studentName: "Maria Lopez", sectionId: period4.id });

      updateAssignment(assignment, form({ sectionsText: "Period 3\nPeriod 4 | P4, 4th\nPeriod 5" }));

      expect(getSubmission(paper.id)).toMatchObject({ sectionId: period4.id, sectionSource: "teacher", status: "graded", flags: [] });
    });

    it("are placed once sections are added, if they were confirmed while there were none", async () => {
      const { assignment, paper } = await withGradedPaper();
      updateIdentity(getSubmission(paper.id)!, { studentName: "Maria Lopez", sectionId: null });
      expect(getSubmission(paper.id)).toMatchObject({ nameSource: "teacher", sectionSource: null });

      updateAssignment(assignment, form({ sectionsText: "Period 3" }));

      expect(getSubmission(paper.id)).toMatchObject({
        sectionId: sectionNamed(assignment, "Period 3").id, sectionSource: "ai", status: "graded",
      });
    });
  });
});

describe("lifecycle", () => {
  it("opens only with an approved key, and closes only once opened", () => {
    const a = createAssignment(teacher.id, form());
    expect(() => setAssignmentStatus(a, "open")).toThrow(expect.objectContaining({ code: "key_not_ready" }));
    expect(() => setAssignmentStatus(a, "closed")).toThrow(expect.objectContaining({ code: "invalid_state" }));

    seedApprovedKey(a.id, [{}]);
    expect(setAssignmentStatus(a, "open").status).toBe("open");
    expect(setAssignmentStatus(a, "closed").status).toBe("closed");
    expect(setAssignmentStatus(a, "open").status).toBe("open");
  });

  it("opens only while student uploads are turned on; closing still works", () => {
    const a = createAssignment(teacher.id, form());
    seedApprovedKey(a.id, [{}]);
    setStudentUploads(false);

    expect(() => setAssignmentStatus(a, "open")).toThrow(expect.objectContaining({
      code: "invalid_state", message: "Student submissions are turned off. Turn them on in Settings to open an assignment.",
    }));
    expect(getAssignment(a.id)!.status).toBe("draft");

    setStudentUploads(true);
    setAssignmentStatus(a, "open");
    setStudentUploads(false);
    expect(setAssignmentStatus(a, "closed").status).toBe("closed");
  });

  it("releases feedback and can take it back", () => {
    const a = createAssignment(teacher.id, form());
    expect(setFeedbackReleased(a, true).feedbackReleasedAt).toBe(T0);
    setClockForTests(() => T0 + 1000);
    expect(setFeedbackReleased(a, true).feedbackReleasedAt).toBe(T0);
    expect(setFeedbackReleased(a, false).feedbackReleasedAt).toBeNull();
  });

  it("rotates the share code", () => {
    const a = createAssignment(teacher.id, form());
    const rotated = rotateShareCode(a);
    expect(rotated.shareCode).not.toBe(a.shareCode);
    expect(rotated.shareCode).toHaveLength(6);
  });

  it("deletes the assignment with its rows and files", async () => {
    const { assignment, paper } = await withGradedPaper();
    const dir = path.join(getConfig().dataDir, "files", assignment.id);
    expect(fs.existsSync(dir)).toBe(true);

    await deleteAssignment(assignment);

    expect(getAssignment(assignment.id)).toBeNull();
    expect(getSubmission(paper.id)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
