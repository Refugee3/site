import { beforeEach, describe, expect, it } from "vitest";
import type { ChatGptClient } from "@/lib/ai/chatgpt/client";
import { makeGradingOutput } from "@/lib/grading/test-utils";
import { setClockForTests } from "@/lib/clock";
import { getSubmission } from "@/lib/db/repos/submissions";
import { answeringGrader, drainQueue } from "@/lib/jobs/test-utils";
import { saveKey } from "@/lib/services/keys";
import { hidePaperNames, saveNamesSettings } from "@/lib/services/names";
import { ingestScan, onePassAvailable } from "@/lib/services/scans";
import { getScan } from "@/lib/db/repos/scans";
import { ingestTeacherUpload } from "@/lib/services/submissions";
import { buildGradesCsv } from "@/lib/services/views";
import { readDataFile } from "@/lib/storage/files";
import type { Assignment } from "@/lib/types";
import { makePdf, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";

let assignment: Assignment;

beforeEach(() => {
  setClockForTests(() => 1_700_000_000_000);
  useTestDb();
  assignment = seedAssignment(seedTeacher().id);
  saveKey(assignment, {
    teacherNotes: "", acknowledgeAiProposed: false,
    items: [{ id: null, label: "1", groupLabel: "", prompt: "", answerType: "short_answer", expectedAnswer: "4", acceptableAnswers: [],
      gradingCriteria: "", pointsCenti: 100, partialCredit: true, page: null }],
  });
});

async function upload(pages = 2): Promise<string> {
  return (await ingestTeacherUpload(assignment, [{ filename: "p.pdf", bytes: await makePdf(pages) }])).submissionId;
}

describe("student names hidden by ChatGPT", () => {
  it("are off until turned on, and then turn off grading in one pass", () => {
    expect(onePassAvailable(assignment.id)).toBe(true);
    saveNamesSettings({ enabled: true, apiKey: "", baseUrl: "", model: "" });
    expect(onePassAvailable(assignment.id)).toBe(false);
  });

  it("send the grading AI only the copy with the names covered, and take the name from ChatGPT", async () => {
    saveNamesSettings({ enabled: true, apiKey: "", baseUrl: "", model: "" });
    const id = await upload();
    const sentPdfs: Uint8Array[] = [];
    await drainQueue(answeringGrader((refs, input) => {
      sentPdfs.push((input as { studentPdf: Uint8Array }).studentPdf);
      return makeGradingOutput(refs, { student: { name: "Name The Grader Made Up", name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false } });
    }));

    const paper = getSubmission(id)!;
    expect(paper.statusNote).toBeNull();
    expect(paper.status).toBe("graded");
    expect(paper.anonId).toMatch(/^S-\d{6}$/);
    expect(paper.studentName).toMatch(/^Practice Student /);
    expect(paper.namesHidden).toMatchObject({ covered: 1 });
    const hidden = await readDataFile(paper.namesHiddenPdfPath!);
    const original = await readDataFile(paper.pdfPath);
    expect(Buffer.from(sentPdfs[0]).equals(Buffer.from(hidden))).toBe(true);
    expect(Buffer.from(sentPdfs[0]).equals(Buffer.from(original))).toBe(false);
    const csv = buildGradesCsv(assignment).csv.split("\n");
    expect(csv[0]).toMatch(/^\ufeff?"Section","Student name","Anonymous ID","Status"/);
    expect(csv[1]).toContain(`"${paper.anonId}"`);
  });

  it("reuse the covered copy when a paper is graded again", async () => {
    saveNamesSettings({ enabled: true, apiKey: "", baseUrl: "", model: "" });
    const id = await upload(1);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));
    const first = getSubmission(id)!;
    const never: ChatGptClient = { model: "x", json: () => Promise.reject(new Error("ChatGPT shouldn't be called again")) };
    const again = await hidePaperNames(first, { client: never });
    expect(again).toMatchObject({ anonId: first.anonId, usage: null });
  });

  it("don't send a paper whose name ChatGPT still sees after covering it twice", async () => {
    const id = await upload(1);
    const stubborn: ChatGptClient = {
      model: "x",
      async json(call) {
        const mark = { page: 1, kind: "name", x_min: 10, y_min: 10, x_max: 200, y_max: 60 };
        const answer = call.name === "names_found"
          ? { student: { name: "Ada", name_confidence: "high", section_raw: null, multiple_students_detected: false }, marks: [mark] }
          : { visible: true, marks: [mark] };
        return { output: call.schema.parse(answer), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    };
    await expect(hidePaperNames(getSubmission(id)!, { client: stubborn })).rejects.toMatchObject({ code: "names_visible" });
    expect(getSubmission(id)!.namesHiddenPdfPath).toBeNull();
  });

  it("have ChatGPT, not the grading AI, read a class scan's pages to split it", async () => {
    saveNamesSettings({ enabled: true, apiKey: "", baseUrl: "", model: "" });
    const scan = await ingestScan(assignment, { filename: "stack.pdf", bytes: await makePdf(3, { label: "class" }) }, { mode: "one_pass", pagesPerPaper: null });
    expect(scan.splitMode).toBe("auto");
    let gradingAiReadScan = false;
    const grader = answeringGrader((refs) => makeGradingOutput(refs));
    await drainQueue({ ...grader, readScanPages: async (...args) => { gradingAiReadScan = true; return grader.readScanPages(...args); } });

    expect(gradingAiReadScan).toBe(false);
    const split = getScan(scan.id)!;
    expect(split.aiModel).toBe("fake-chatgpt");
    expect(split.readings.map((r) => r?.studentName)).toEqual(["Practice Student 1", "Practice Student 2", "Practice Student 3"]);
  });
});
