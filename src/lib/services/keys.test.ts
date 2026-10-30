import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import type { DB } from "@/lib/db/connection";
import { getAssignment } from "@/lib/db/repos/assignments";
import { getKey, listKeyItems, updateKey } from "@/lib/db/repos/keys";
import { getSubmission, updateSubmission } from "@/lib/db/repos/submissions";
import { makeGradingOutput } from "@/lib/grading/test-utils";
import { answeringGrader, drainQueue, FAKE_META, jobRows, scriptedGrader } from "@/lib/jobs/test-utils";
import type { KeyExtraction } from "@/lib/ai/schemas";
import { ingestKeyPdf, retryKeyExtraction, saveGradingInstructions, saveKey } from "@/lib/services/keys";
import { ingestTeacherUpload } from "@/lib/services/submissions";
import type { UploadedFile } from "@/lib/storage/pdf";
import type { Assignment, KeyItem, SaveKeyInput } from "@/lib/types";
import { makePdf, seedAssignment, seedSubmission, seedTeacher, useTestDb } from "@/test/helpers";

let db: DB;
let assignment: Assignment;

beforeEach(() => {
  setClockForTests(() => 1_700_000_000_000);
  db = useTestDb();
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

  it("reads the key with the teacher's instructions, which then count when grading", async () => {
    const instructions = "Question 1 has two parts: 1 point for the setup, 1 for the answer. Don't grade question 2.";
    const key = await ingestKeyPdf(assignment, await keyFile(), `  ${instructions}  `);
    expect(key.teacherNotes).toBe(instructions);

    const seen: string[] = [];
    const item = (o: Partial<KeyExtraction["items"][number]>): KeyExtraction["items"][number] => ({
      label: "1a", group_label: "1", prompt: "", answer_type: "numeric", expected_answer: "4", acceptable_answers: [], grading_criteria: "",
      points: 1, group_points: null, graded: true, page: 1, answer_source: "key", confidence: "high", note: "", ...o,
    });
    await drainQueue(scriptedGrader({
      async extractKey(input) {
        seen.push(input.teacherNotes);
        return {
          output: {
            document_kind: "answer_key", stated_total_points: null, notes: "", questions_for_teacher: [], suggested_title: null,
            items: [item({ prompt: "1: setup" }), item({ label: "1b", prompt: "1: answer" }), item({ label: "2", group_label: "", graded: false })],
          },
          meta: FAKE_META,
        };
      },
    }));

    expect(seen).toEqual([instructions]);
    expect(listKeyItems(assignment.id).map((i) => [i.label, i.graded])).toEqual([["1a", true], ["1b", true], ["2", false]]);
  });

  it("refuses instructions that are too long", async () => {
    await expect(ingestKeyPdf(assignment, await keyFile(), "x".repeat(4001))).rejects.toMatchObject({ code: "validation" });
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

  it("rejects a file of an unknown type before storing anything", async () => {
    await expect(ingestKeyPdf(assignment, { filename: "key.pdf", bytes: new TextEncoder().encode("hello") }))
      .rejects.toMatchObject({ code: "unsupported_type" });
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

  it("can read it again with new instructions", async () => {
    await ingestKeyPdf(assignment, await keyFile(), "Old.");
    updateKey(assignment.id, { status: "failed" });
    await drainQueue();

    retryKeyExtraction(assignment, " Split 3 into setup and answer. ");
    expect(getKey(assignment.id)).toMatchObject({ status: "processing", teacherNotes: "Split 3 into setup and answer." });
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
    const result = saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row(), row({ label: "2" })] });

    expect(result).toEqual({ revision: 1, staleCount: 0 });
    expect(getKey(assignment.id)).toMatchObject({ status: "ready", revision: 1, approvedRevision: 1, errorMessage: null });
    expect(listKeyItems(assignment.id)).toHaveLength(2);
  });

  it("saves and approves without changing the assignment's stored status", () => {
    const result = saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] });

    expect(result).toEqual({ revision: 1, staleCount: 0 });
    expect(getKey(assignment.id)).toMatchObject({ status: "ready", approvedRevision: 1 });
    expect(getAssignment(assignment.id)!.status).toBe("draft");
  });

  it("re-approves an unchanged key without a new revision, and rescores on new points", async () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row(), row({ label: "2" })] });
    const { submissionId: paperId } = await ingestTeacherUpload(assignment, [{ filename: "p.pdf", bytes: await makePdf(1) }]);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));
    expect(getSubmission(paperId)!.scoreEarnedCenti).toBe(200);

    const items = listKeyItems(assignment.id);
    const result = saveKey(assignment, {
      teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf(items, (item) => ({ pointsCenti: item.label === "2" ? 300 : 100 })),
    });

    expect(result).toEqual({ revision: 1, staleCount: 0 });
    expect(getSubmission(paperId)).toMatchObject({ scoreEarnedCenti: 400, scoreMaxCenti: 400 });
  });

  it("starts a new revision when an expected answer changes, making graded papers stale", () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] });
    const graded = seedSubmission(assignment.id, { status: "graded" });
    db.prepare("UPDATE submissions SET graded_key_revision = 1 WHERE id = ?").run(graded.id);
    seedSubmission(assignment.id, { status: "queued" });

    const result = saveKey(assignment, {
      teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf(listKeyItems(assignment.id), () => ({ expectedAnswer: "x = 5" })),
    });

    expect(result).toEqual({ revision: 2, staleCount: 1 });
    expect(getKey(assignment.id)).toMatchObject({ revision: 2, approvedRevision: 2 });
  });

  it("needs the acknowledgement for AI-proposed answers, which then become the teacher's", () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] });
    const [item] = listKeyItems(assignment.id);
    db.prepare("UPDATE key_items SET answer_source = 'ai_proposed' WHERE id = ?").run(item.id);

    expect(() => saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf([item]) }))
      .toThrow(expect.objectContaining({ code: "validation", extra: { fieldErrors: { acknowledgeAiProposed: [expect.any(String)] } } }));

    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: true, items: rowsOf([item]) });
    expect(listKeyItems(assignment.id)[0].answerSource).toBe("teacher");
  });

  it("is refused while the key is being read", () => {
    updateKey(assignment.id, { status: "processing" });
    expect(() => saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row()] }))
      .toThrow(expect.objectContaining({ code: "invalid_state" }));
  });
});

describe("questions left out of the grade", () => {
  async function gradedPaper(): Promise<{ id: string; labelsSent: string[] }> {
    const labelsSent: string[] = [];
    const { submissionId } = await ingestTeacherUpload(assignment, [{ filename: "p.pdf", bytes: await makePdf(1) }]);
    await drainQueue(answeringGrader((refs, input) => {
      labelsSent.push(...input.items.map((item) => item.label));
      return makeGradingOutput(refs);
    }));
    return { id: submissionId, labelsSent };
  }

  it("aren't sent to the AI or scored", async () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row(), row({ label: "2", graded: false }), row({ label: "3" })] });
    const paper = await gradedPaper();

    expect(paper.labelsSent).toEqual(["1", "3"]);
    expect(getSubmission(paper.id)).toMatchObject({ scoreEarnedCenti: 200, scoreMaxCenti: 200 });
  });

  it("just rescore when left out; counting one again makes graded papers stale", async () => {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row(), row({ label: "2" })] });
    const paper = await gradedPaper();
    const items = listKeyItems(assignment.id);

    expect(saveKey(assignment, {
      teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf(items, (item) => ({ graded: item.label !== "2" })),
    })).toEqual({ revision: 1, staleCount: 0 });
    expect(getSubmission(paper.id)).toMatchObject({ scoreEarnedCenti: 100, scoreMaxCenti: 100 });

    // A save that doesn't say (an older form, the Workspace's "Approve key") keeps the question left out.
    expect(saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf(items) })).toEqual({ revision: 1, staleCount: 0 });
    expect(listKeyItems(assignment.id).map((item) => item.graded)).toEqual([true, false]);

    expect(saveKey(assignment, {
      teacherNotes: "", acknowledgeAiProposed: false, items: rowsOf(items, () => ({ graded: true })),
    })).toEqual({ revision: 2, staleCount: 1 });
  });

  it("can't be every question", () => {
    expect(() => saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row({ graded: false })] }))
      .toThrow(expect.objectContaining({ code: "validation", message: "Keep at least one question counted in the grade." }));
  });
});

describe("saveGradingInstructions", () => {
  function approvedKey(): KeyItem[] {
    saveKey(assignment, { teacherNotes: "", acknowledgeAiProposed: false, items: [row(), row({ label: "2" }), row({ label: "3" })] });
    return listKeyItems(assignment.id);
  }

  it("saves the instructions, keeps the key approved and makes graded papers stale", () => {
    approvedKey();
    const graded = seedSubmission(assignment.id, { status: "graded" });
    db.prepare("UPDATE submissions SET graded_key_revision = 1 WHERE id = ?").run(graded.id);

    expect(saveGradingInstructions(assignment, { text: "  Grade the work on 3, not just the answer. " })).toEqual({ changed: true, staleCount: 1 });
    expect(getKey(assignment.id)).toMatchObject({ teacherNotes: "Grade the work on 3, not just the answer.", revision: 2, approvedRevision: 2 });

    expect(saveGradingInstructions(assignment, { text: "Grade the work on 3, not just the answer." })).toEqual({ changed: false, staleCount: 0 });
    expect(getKey(assignment.id)!.revision).toBe(2);
  });

  it("sets which questions count", () => {
    const items = approvedKey();
    const only = items.filter((item) => item.label !== "2").map((item) => item.id);

    expect(saveGradingInstructions(assignment, { text: "Skip 2.", gradedItemIds: only })).toEqual({ changed: true, staleCount: 0 });
    expect(listKeyItems(assignment.id).map((item) => item.graded)).toEqual([true, false, true]);
    expect(() => saveGradingInstructions(assignment, { text: "Skip 2.", gradedItemIds: [] }))
      .toThrow(expect.objectContaining({ code: "validation" }));
  });

  it("doesn't approve an unapproved key, and waits for a key being read", () => {
    approvedKey();
    updateKey(assignment.id, { approvedRevision: null });
    saveGradingInstructions(assignment, { text: "Units required." });
    expect(getKey(assignment.id)).toMatchObject({ revision: 2, approvedRevision: null });

    updateKey(assignment.id, { status: "processing" });
    expect(() => saveGradingInstructions(assignment, { text: "Other." })).toThrow(expect.objectContaining({ code: "invalid_state" }));
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
