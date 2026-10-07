import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import type { DB } from "@/lib/db/connection";
import { getAssignment } from "@/lib/db/repos/assignments";
import { getKey, listKeyItems, updateKey } from "@/lib/db/repos/keys";
import { getSubmission, getSubmissionByReceipt, updateSubmission } from "@/lib/db/repos/submissions";
import { makeGradingOutput } from "@/lib/grading/test-utils";
import { answeringGrader, drainQueue, jobRows } from "@/lib/jobs/test-utils";
import { ingestKeyPdf, retryKeyExtraction, saveKey } from "@/lib/services/keys";
import { setStudentUploads } from "@/lib/services/settings";
import { ingestStudentUpload } from "@/lib/services/submissions";
import type { UploadedFile } from "@/lib/storage/pdf";
import type { Assignment, KeyItem, SaveKeyInput } from "@/lib/types";
import { enableStudentUploads, makePdf, seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

let db: DB;
let assignment: Assignment;

beforeEach(() => {
  setClockForTests(() => 1_700_000_000_000);
  db = useTestDb();
  enableStudentUploads();
  assignment = seedAssignment(seedTeacher().id);
});

async function keyFile(label = "key"): Promise<UploadedFile> {
  return { filename: `${label}.pdf`, bytes: await makePdf(2, { label }) };
}

function keyFiles(): string[] {
  const dir = path.join(getConfig().dataDir, "files", assignment.id, "key");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

type Row = SaveKeyInput["items"][number];

function row(o: Partial<Row> = {}): Row {
  return {
    id: null, label: "1", groupLabel: "", prompt: "", answerType: "short_answer", expectedAnswer: "x = 4", acceptableAnswers: [],
    gradingCriteria: "", pointsCenti: 100, partialCredit: true, page: null, ...o,
  };
}

function rowsOf(items: KeyItem[], change: (item: KeyItem) => Partial<Row> = () => ({})): Row[] {
  return items.map((item) => row({
    id: item.id, label: item.label, groupLabel: item.groupLabel, prompt: item.prompt, answerType: item.answerType,
    expectedAnswer: item.expectedAnswer, acceptableAnswers: item.acceptableAnswers, gradingCriteria: item.gradingCriteria,
    pointsCenti: item.pointsCenti, partialCredit: item.partialCredit, page: item.page, ...change(item),
  }));
}

describe("ingestKeyPdf", () => {
  it("stores the PDF, marks the key processing and queues extraction", async () => {
    const key = await ingestKeyPdf(assignment, await keyFile());

    expect(key).toMatchObject({
      status: "processing", sourceFilename: "key.pdf", sourcePageCount: 2, errorMessage: null,
      processingStartedAt: 1_700_000_000_000, processingFinishedAt: null,
    });
    expect(keyFiles()).toHaveLength(1);
    expect(jobRows(assignment.id)).toMatchObject([{ kind: "extract_key", status: "queued", priority: 0 }]);
  });

  it("replaces an earlier key PDF, keeps the teacher's notes and removes the old file", async () => {
    await ingestKeyPdf(assignment, await keyFile("first"));
    updateKey(assignment.id, { status: "failed", teacherNotes: "Units required." });

    const key = await ingestKeyPdf(assignment, await keyFile("second"));

    expect(key).toMatchObject({ status: "processing", teacherNotes: "Units required." });
    expect(keyFiles()).toEqual([path.basename(key.sourcePdfPath!)]);
  });

  it("refuses while the key is still being read", async () => {
    await ingestKeyPdf(assignment, await keyFile("first"));
    await expect(ingestKeyPdf(assignment, await keyFile("second"))).rejects.toMatchObject({ code: "invalid_state" });
    expect(keyFiles()).toHaveLength(1);
  });

  it("is key_locked once a paper is graded, and already while one is grading", async () => {
    const file = await keyFile();
    const paper = seedSubmission(assignment.id, { status: "grading" });
    await expect(ingestKeyPdf(assignment, file)).rejects.toMatchObject({ code: "key_locked" });

    updateSubmission(paper.id, { status: "needs_review" });
    await expect(ingestKeyPdf(assignment, file)).rejects.toMatchObject({ code: "key_locked" });
    expect(keyFiles()).toEqual([]);

    updateSubmission(paper.id, { status: "failed" });
    await expect(ingestKeyPdf(assignment, file)).resolves.toMatchObject({ status: "processing" });
  });

  it("rejects a file that is not a PDF before storing anything", async () => {
    await expect(ingestKeyPdf(assignment, { filename: "key.pdf", bytes: new TextEncoder().encode("hello") }))
      .rejects.toMatchObject({ code: "not_pdf" });
    expect(getKey(assignment.id)!.status).toBe("empty");
  });
});

describe("retryKeyExtraction", () => {
  it("reads the stored PDF again", async () => {
    await ingestKeyPdf(assignment, await keyFile());
    updateKey(assignment.id, { status: "failed", errorMessage: "No questions found" });
    await drainQueue(); // the earlier job finishes without writing: the key is no longer processing

    setClockForTests(() => 1_700_000_005_000);
    retryKeyExtraction(assignment);

    expect(getKey(assignment.id)).toMatchObject({
      status: "processing", errorMessage: null, processingStartedAt: 1_700_000_005_000, processingFinishedAt: null,
    });
    expect(jobRows(assignment.id).at(-1)).toMatchObject({ status: "queued" });
  });

  it("needs an uploaded PDF and an unlocked key", async () => {
    expect(() => retryKeyExtraction(assignment)).toThrow(expect.objectContaining({ code: "invalid_state" }));

    await ingestKeyPdf(assignment, await keyFile());
    updateKey(assignment.id, { status: "ready" });
    seedSubmission(assignment.id, { status: "graded" });
    expect(() => retryKeyExtraction(assignment)).toThrow(expect.objectContaining({ code: "key_locked" }));
  });
});

describe("saveKey", () => {
  it("approves a manually built key at revision 1", () => {
    const result = saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row(), row({ label: "2" })] }, { open: false });

    expect(result).toEqual({ revision: 1, staleCount: 0 });
    expect(getKey(assignment.id)).toMatchObject({ status: "ready", revision: 1, approvedRevision: 1, errorMessage: null });
    expect(listKeyItems(assignment.id)).toHaveLength(2);
  });

  it("saves and approves without opening the assignment while student uploads are turned off", () => {
    setStudentUploads(false);
    const result = saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] }, { open: true });

    expect(result).toEqual({ revision: 1, staleCount: 0 });
    expect(getKey(assignment.id)).toMatchObject({ status: "ready", approvedRevision: 1 });
    expect(getAssignment(assignment.id)!.status).toBe("draft");
  });

  it("re-approves an unchanged key without a new revision, and rescores on new points", async () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row(), row({ label: "2" })] }, { open: true });
    expect(getAssignment(assignment.id)!.status).toBe("open");
    const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [{ filename: "p.pdf", bytes: await makePdf(1) }]);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));
    const paperId = getSubmissionByReceipt(receiptUrl.slice("/r/".length))!.id;
    expect(getSubmission(paperId)!.scoreEarnedCenti).toBe(200);

    const items = listKeyItems(assignment.id);
    const result = saveKey(assignment, {
      teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf(items, (item) => ({ pointsCenti: item.label === "2" ? 300 : 100 })),
    }, { open: false });

    expect(result).toEqual({ revision: 1, staleCount: 0 });
    expect(getSubmission(paperId)).toMatchObject({ scoreEarnedCenti: 400, scoreMaxCenti: 400 });
  });

  it("starts a new revision when an expected answer changes, making graded papers stale", () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] }, { open: false });
    const graded = seedSubmission(assignment.id, { status: "graded" });
    db.prepare("UPDATE submissions SET graded_key_revision = 1 WHERE id = ?").run(graded.id);
    seedSubmission(assignment.id, { status: "queued" });

    const result = saveKey(assignment, {
      teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf(listKeyItems(assignment.id), () => ({ expectedAnswer: "x = 5" })),
    }, { open: false });

    expect(result).toEqual({ revision: 2, staleCount: 1 });
    expect(getKey(assignment.id)).toMatchObject({ revision: 2, approvedRevision: 2 });
  });

  it("needs the acknowledgement for AI-proposed answers, which then become the teacher's", () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] }, { open: false });
    const [item] = listKeyItems(assignment.id);
    db.prepare("UPDATE key_items SET answer_source = 'ai_proposed' WHERE id = ?").run(item.id);

    expect(() => saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf([item]) }, { open: false }))
      .toThrow(expect.objectContaining({ code: "validation", extra: { fieldErrors: { acknowledgeAiProposed: [expect.any(String)] } } }));

    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: true, items: rowsOf([item]) }, { open: false });
    expect(listKeyItems(assignment.id)[0].answerSource).toBe("teacher");
  });

  it("is refused while the key is being read", () => {
    updateKey(assignment.id, { status: "processing" });
    expect(() => saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] }, { open: false }))
      .toThrow(expect.objectContaining({ code: "invalid_state" }));
  });
});

describe("reading the key", () => {
  it("records when the AI's reading was stored, for the typical reading time", async () => {
    await ingestKeyPdf(assignment, await keyFile());
    setClockForTests(() => 1_700_000_030_000);

    await drainQueue();

    expect(getKey(assignment.id)).toMatchObject({
      status: "ready", processingStartedAt: 1_700_000_000_000, processingFinishedAt: 1_700_000_030_000,
    });
  });
});
