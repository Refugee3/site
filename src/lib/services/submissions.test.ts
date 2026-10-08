import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setClockForTests } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/connection";
import { listSections, updateAssignment as updateAssignmentRow } from "@/lib/db/repos/assignments";
import { updateKey } from "@/lib/db/repos/keys";
import { listLessons } from "@/lib/db/repos/lessons";
import { countSubmissions, getSubmission, getSubmissionByReceipt, listItems, updateSubmission } from "@/lib/db/repos/submissions";
import { setGradingPreferences } from "@/lib/db/repos/teachers";
import { makeGradingOutput, makeOutputItem } from "@/lib/grading/test-utils";
import { sha256Hex } from "@/lib/ids";
import { PRIORITY } from "@/lib/jobs/queue";
import { answeringGrader, drainQueue, jobRows } from "@/lib/jobs/test-utils";
import { loadGuidance } from "@/lib/services/guidance";
import { setStudentUploads } from "@/lib/services/settings";
import {
  deleteSubmission, gradeManually, ingestStudentUpload, ingestTeacherUpload, markReviewed, regradeStale, regradeSubmission,
  regradeWithGuidance, retryFailed, saveItemOverride, setOverallFeedback, setTotalOverride, storeTeacherPaper, updateIdentity,
} from "@/lib/services/submissions";
import type { UploadedFile } from "@/lib/storage/pdf";
import type { Assignment, KeyItem, Submission } from "@/lib/types";
import {
  enableStudentUploads, makePdf, seedApprovedKey, seedAssignment, seedSubmission, seedTeacher, TINY_JPEG, useTestDb,
} from "@/test/helpers";

const T0 = 1_700_000_000_000;
const ORIGIN = "https://school.test";
const UPLOAD_ID = "0123456789abcdef0123456789abcdef";
let assignment: Assignment;
let items: KeyItem[];

beforeEach(() => {
  setClockForTests(() => T0);
  useTestDb();
  enableStudentUploads();
  assignment = seedAssignment(seedTeacher().id, { status: "open" });
  items = seedApprovedKey(assignment.id, [{ label: "1" }, { label: "2", pointsCenti: 200 }]);
});

async function pdfFile(label: string, pages = 1): Promise<UploadedFile> {
  return { filename: `${label}.pdf`, bytes: await makePdf(pages, { label }) };
}

function byReceipt(receiptUrl: string): Submission {
  return getSubmissionByReceipt(receiptUrl.slice(receiptUrl.lastIndexOf("/") + 1))!;
}

/** A paper read as "Maria Lopez", submitted `minute` minutes after T0 (the newest one is the board's current row). */
function mariaLopezPaper(status: "failed" | "graded", minute: number): string {
  const { id } = seedSubmission(assignment.id);
  updateSubmission(id, { status, studentName: "Maria Lopez", nameKey: "lopez maria", nameSortKey: "lopez maria" });
  getDb().prepare("UPDATE submissions SET created_at = ? WHERE id = ?").run(T0 + minute * 60_000, id);
  return id;
}

function storedFiles(a: Assignment): string[] {
  const dir = path.join(getConfig().dataDir, "files", a.id, "submissions");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Uploads a paper and grades it with every item answered correctly (no review flags). */
async function gradedPaper(label = "maria"): Promise<Submission> {
  const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [await pdfFile(label)]);
  await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));
  const s = byReceipt(receiptUrl);
  expect(s.status).toBe("graded");
  return s;
}

describe("ingestStudentUpload", () => {
  it("stores the PDF and queues a student-priority grading job", async () => {
    const result = await ingestStudentUpload(assignment.shareCode, [await pdfFile("maria")]);

    expect(result).toEqual({ receiptUrl: expect.stringMatching(/^\/r\/[A-Za-z0-9_-]{43}$/), duplicate: false });
    const s = byReceipt(result.receiptUrl);
    expect(s).toMatchObject({ status: "queued", source: "student", pageCount: 1, originalFilename: "maria.pdf" });
    expect(fs.existsSync(path.join(getConfig().dataDir, s.pdfPath))).toBe(true);
    expect(jobRows(s.id)).toMatchObject([{ kind: "grade_submission", status: "queued", priority: PRIORITY.student }]);
  });

  it("merges a PDF and a photo into one paper", async () => {
    const parts = [await pdfFile("first", 2), { filename: "photo.jpg", bytes: TINY_JPEG }];
    const s = byReceipt((await ingestStudentUpload(assignment.shareCode, parts)).receiptUrl);
    expect(s).toMatchObject({ pageCount: 3, originalFilename: "first.pdf + 1 more" });
  });

  it("refuses an assignment that is not open", async () => {
    const file = await pdfFile("maria");
    updateAssignmentRow(assignment.id, { status: "closed" });
    await expect(ingestStudentUpload(assignment.shareCode, [file])).rejects.toMatchObject({ code: "closed" });

    const draft = seedAssignment(seedTeacher().id);
    seedApprovedKey(draft.id, [{}]);
    await expect(ingestStudentUpload(draft.shareCode, [file])).rejects.toMatchObject({ code: "closed" });
    expect(countSubmissions(assignment.id) + countSubmissions(draft.id)).toBe(0);
  });

  it("rejects an unknown share code", async () => {
    await expect(ingestStudentUpload("ZZZZZZ", [await pdfFile("maria")])).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses every upload while student uploads are turned off, before looking up the code", async () => {
    setStudentUploads(false);
    const closed = {
      code: "closed", message: "Your teacher isn't accepting online submissions. Hand your paper to your teacher instead.",
    };
    await expect(ingestStudentUpload(assignment.shareCode, [await pdfFile("maria")])).rejects.toMatchObject(closed);
    await expect(ingestStudentUpload("ZZZZZZ", [await pdfFile("maria")])).rejects.toMatchObject(closed);
    expect(countSubmissions(assignment.id)).toBe(0);
    expect(storedFiles(assignment)).toEqual([]);
  });

  it("returns the earlier receipt when the same browser sends the same upload again", async () => {
    const parts = [await pdfFile("maria")];
    const first = await ingestStudentUpload(assignment.shareCode, parts, UPLOAD_ID);
    const replay = await ingestStudentUpload(assignment.shareCode, parts, UPLOAD_ID);

    expect(replay).toEqual({ receiptUrl: first.receiptUrl, duplicate: true });
    expect(countSubmissions(assignment.id)).toBe(1);
    expect(byReceipt(first.receiptUrl).clientUploadId).toBe(UPLOAD_ID);
  });

  it("never hands another upload of the same bytes the earlier student's receipt", async () => {
    const parts = [await pdfFile("maria")];
    await ingestStudentUpload(assignment.shareCode, parts, UPLOAD_ID);
    for (const otherId of ["another-upload-id-42", null]) {
      await expect(ingestStudentUpload(assignment.shareCode, parts, otherId)).rejects.toMatchObject({ code: "duplicate" });
    }
    // An upload sent without an id cannot be replayed either.
    const anonymous = [await pdfFile("ana")];
    await ingestStudentUpload(assignment.shareCode, anonymous);
    await expect(ingestStudentUpload(assignment.shareCode, anonymous)).rejects.toMatchObject({ code: "duplicate" });
    expect(countSubmissions(assignment.id)).toBe(2);
  });

  it("returns one receipt for a double tap (two identical uploads at once)", async () => {
    const parts = [await pdfFile("maria")];
    const [a, b] = await Promise.all([
      ingestStudentUpload(assignment.shareCode, parts, UPLOAD_ID),
      ingestStudentUpload(assignment.shareCode, parts, UPLOAD_ID),
    ]);

    expect(a.receiptUrl).toBe(b.receiptUrl);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(storedFiles(assignment)).toHaveLength(1);
  });

  it("refuses the answer key uploaded as a paper", async () => {
    const file = await pdfFile("key");
    updateKey(assignment.id, { sourceSha256: sha256Hex(file.bytes) });
    await expect(ingestStudentUpload(assignment.shareCode, [file])).rejects.toMatchObject({ code: "is_answer_key" });
  });

  it("refuses a student upload identical to a teacher's upload", async () => {
    const file = await pdfFile("scan");
    await ingestTeacherUpload(assignment, file, ORIGIN);
    await expect(ingestStudentUpload(assignment.shareCode, [file])).rejects.toMatchObject({ code: "duplicate" });
  });

  it("enforces the submission limit and removes the file it wrote", async () => {
    const limited = seedAssignment(seedTeacher().id, { status: "open", maxSubmissions: 1 });
    seedApprovedKey(limited.id, [{}]);
    await ingestStudentUpload(limited.shareCode, [await pdfFile("first")]);

    await expect(ingestStudentUpload(limited.shareCode, [await pdfFile("second")])).rejects.toMatchObject({ code: "submission_limit" });
    expect(countSubmissions(limited.id)).toBe(1);
    expect(storedFiles(limited)).toHaveLength(1);
  });
});

describe("ingestTeacherUpload", () => {
  it("needs an approved key", async () => {
    const draft = seedAssignment(seedTeacher().id);
    await expect(ingestTeacherUpload(draft, await pdfFile("scan"), ORIGIN)).rejects.toMatchObject({ code: "key_not_ready" });
  });

  it("stores a scanned paper whatever the assignment status, with an absolute receipt link", async () => {
    updateAssignmentRow(assignment.id, { status: "closed" });
    const result = await ingestTeacherUpload(assignment, await pdfFile("scan", 2), ORIGIN);

    const s = getSubmission(result.submissionId)!;
    expect(result.receiptUrl).toBe(`${ORIGIN}/r/${s.receiptToken}`);
    expect(s).toMatchObject({ source: "teacher", pageCount: 2, status: "queued" });
    expect(jobRows(s.id)).toMatchObject([{ status: "queued", priority: PRIORITY.teacher }]);
  });

  it("accepts photos as well as PDFs, but not unknown file types", async () => {
    await expect(ingestTeacherUpload(assignment, { filename: "photo.jpg", bytes: TINY_JPEG }, ORIGIN))
      .resolves.toMatchObject({ submissionId: expect.any(String) });
    await expect(ingestTeacherUpload(assignment, { filename: "notes.bin", bytes: new TextEncoder().encode("hello") }, ORIGIN))
      .rejects.toMatchObject({ code: "unsupported_type" });
  });

  it("rejects a copy of any earlier paper", async () => {
    const file = await pdfFile("maria");
    await ingestStudentUpload(assignment.shareCode, [file]);
    await expect(ingestTeacherUpload(assignment, file, ORIGIN)).rejects.toMatchObject({
      code: "duplicate", message: "This exact file was already submitted for this assignment.",
    });
  });

  it("works while student uploads are turned off", async () => {
    setStudentUploads(false);
    const result = await ingestTeacherUpload(assignment, await pdfFile("scan"), ORIGIN);
    expect(getSubmission(result.submissionId)).toMatchObject({ source: "teacher", status: "queued" });
  });
});

describe("storeTeacherPaper", () => {
  async function paper(label: string) {
    const bytes = await makePdf(2, { label });
    return { bytes, pageCount: 2, contentSha256: sha256Hex(bytes) };
  }

  it("stores a teacher paper and queues its grading", async () => {
    const s = (await storeTeacherPaper(assignment, await paper("ana"), "stack.pdf (pages 1–2)"))!;
    expect(s).toMatchObject({ source: "teacher", status: "queued", pageCount: 2, originalFilename: "stack.pdf (pages 1–2)" });
    expect(jobRows(s.id)).toMatchObject([{ kind: "grade_submission", priority: PRIORITY.teacher }]);
  });

  it("returns null for content already in the assignment, also for two at once", async () => {
    const pdf = await paper("ana");
    const [first, second] = await Promise.all([storeTeacherPaper(assignment, pdf, "a.pdf"), storeTeacherPaper(assignment, pdf, "b.pdf")]);
    expect([first, second].filter((s) => s === null)).toHaveLength(1);
    expect(await storeTeacherPaper(assignment, pdf, "c.pdf")).toBeNull();
    expect(countSubmissions(assignment.id)).toBe(1);
    expect(storedFiles(assignment)).toHaveLength(1);
  });

  it("refuses the answer key and an unapproved key", async () => {
    const key = await paper("key");
    updateKey(assignment.id, { sourceSha256: key.contentSha256 });
    await expect(storeTeacherPaper(assignment, key, "k.pdf")).rejects.toMatchObject({ code: "is_answer_key" });
    const draft = seedAssignment(seedTeacher().id);
    await expect(storeTeacherPaper(draft, await paper("ana"), "a.pdf")).rejects.toMatchObject({ code: "key_not_ready" });
  });
});

describe("updateIdentity", () => {
  it("moves needs_review → graded when the edit removes the last review flag", () => {
    const s = updateSubmission(seedSubmission(assignment.id).id, { status: "needs_review", flags: ["name_missing", "section_inferred"] });

    updateIdentity(s, { studentName: "  maria   lopez ", sectionId: null });

    // Without configured sections there was no section to confirm, so it is not pinned as the teacher's.
    expect(getSubmission(s.id)).toMatchObject({
      status: "graded", flags: [], studentName: "Maria Lopez", nameSource: "teacher", nameKey: "lopez maria",
      nameSortKey: "lopez maria", sectionId: null, sectionSource: null,
    });
  });

  it("keeps needs_review while another review flag remains", () => {
    const s = updateSubmission(seedSubmission(assignment.id).id, { status: "needs_review", flags: ["name_missing", "low_confidence"] });
    updateIdentity(s, { studentName: "Maria Lopez", sectionId: null });
    expect(getSubmission(s.id)).toMatchObject({ status: "needs_review", flags: ["low_confidence"] });
  });

  it("keeps a reviewed paper graded and leaves a queued paper's status alone", () => {
    const reviewed = updateSubmission(seedSubmission(assignment.id).id, { status: "graded", reviewedAt: T0, flags: ["low_confidence"] });
    updateIdentity(reviewed, { studentName: "Maria Lopez", sectionId: null });
    expect(getSubmission(reviewed.id)!.status).toBe("graded");

    const queued = seedSubmission(assignment.id);
    updateIdentity(queued, { studentName: "", sectionId: null });
    expect(getSubmission(queued.id)).toMatchObject({ status: "queued", studentName: null, nameSortKey: "~" });
  });

  it("accepts only this assignment's sections and names up to 120 characters", () => {
    const other = seedAssignment(seedTeacher().id, { sections: [{ label: "Period 1", canonicalKey: "1" }] });
    const sectioned = seedAssignment(assignment.teacherId, { sections: [{ label: "Period 3", canonicalKey: "3" }] });
    const s = seedSubmission(sectioned.id);
    const [foreign] = listSections(other.id);
    const [own] = listSections(sectioned.id);

    expect(() => updateIdentity(s, { studentName: "Maria", sectionId: foreign.id })).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => updateIdentity(s, { studentName: "x".repeat(121), sectionId: null })).toThrow(expect.objectContaining({ code: "validation" }));

    updateIdentity(s, { studentName: "Maria", sectionId: own.id });
    expect(getSubmission(s.id)).toMatchObject({ sectionId: own.id, sectionSource: "teacher" });
  });
});

describe("overrides and feedback", () => {
  it("rescoring follows item and total overrides", async () => {
    const s = await gradedPaper();
    expect(s.scoreEarnedCenti).toBe(300);

    saveItemOverride(s, items[1].id, { pointsCenti: 50, feedback: "Show the units." });
    expect(getSubmission(s.id)!.scoreEarnedCenti).toBe(150);
    expect(listItems(s.id)[1]).toMatchObject({ overrideCenti: 50, overrideFeedback: "Show the units." });

    setTotalOverride(s, 250);
    expect(getSubmission(s.id)).toMatchObject({ totalOverrideCenti: 250, scoreEarnedCenti: 250 });
    setTotalOverride(s, null);
    expect(getSubmission(s.id)!.scoreEarnedCenti).toBe(150);
  });

  it("accepts a total override above one item's 1000-point maximum", () => {
    const big = seedAssignment(seedTeacher().id, { status: "open" });
    const [first] = seedApprovedKey(big.id, [{ pointsCenti: 80_000 }, { pointsCenti: 80_000 }]);
    const s = seedSubmission(big.id, { status: "graded" });

    setTotalOverride(s, 120_000);
    expect(getSubmission(s.id)).toMatchObject({ totalOverrideCenti: 120_000, scoreEarnedCenti: 120_000, scoreMaxCenti: 160_000 });
    expect(() => setTotalOverride(s, 12.5)).toThrow(expect.objectContaining({ code: "validation" }));
    // One item's override is still capped at 1000 points.
    expect(() => saveItemOverride(s, first.id, { pointsCenti: 100_001, feedback: null }))
      .toThrow(expect.objectContaining({ code: "validation" }));
  });

  it("stores the teacher's version of the \"what you did\" note, which a regrade keeps", async () => {
    const s = await gradedPaper();
    saveItemOverride(s, items[0].id, { pointsCenti: null, feedback: null, whatStudentDid: "  You cross-multiplied and got x = 4.  " });
    expect(listItems(s.id)[0]).toMatchObject({ overrideWhatStudentDid: "You cross-multiplied and got x = 4.", overrideCenti: null });

    // Leaving it out keeps it; null clears it.
    saveItemOverride(s, items[0].id, { pointsCenti: 50, feedback: null });
    expect(listItems(s.id)[0].overrideWhatStudentDid).toBe("You cross-multiplied and got x = 4.");
    regradeSubmission(s);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));
    expect(listItems(s.id)[0]).toMatchObject({ overrideWhatStudentDid: "You cross-multiplied and got x = 4." });
    saveItemOverride(s, items[0].id, { pointsCenti: null, feedback: null, whatStudentDid: null });
    expect(listItems(s.id)[0].overrideWhatStudentDid).toBeNull();
    expect(() => saveItemOverride(s, items[0].id, { pointsCenti: null, feedback: null, whatStudentDid: "x".repeat(1001) }))
      .toThrow(expect.objectContaining({ code: "validation" }));
  });

  it("refuses an override for an item that is not in this assignment's key", async () => {
    const s = seedSubmission(assignment.id);
    const other = seedAssignment(seedTeacher().id);
    const [foreignItem] = seedApprovedKey(other.id, [{}]);
    expect(() => saveItemOverride(s, foreignItem.id, { pointsCenti: 10, feedback: null })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => setTotalOverride(s, -1)).toThrow(expect.objectContaining({ code: "validation" }));
  });

  it("marks the overall feedback as the teacher's", () => {
    const s = seedSubmission(assignment.id);
    setOverallFeedback(s, "  Great effort.  ");
    expect(getSubmission(s.id)).toMatchObject({ overallFeedback: "Great effort.", overallFeedbackEdited: true });
    expect(() => setOverallFeedback(s, "x".repeat(2001))).toThrow(expect.objectContaining({ code: "validation" }));
  });
});

describe("review workflow", () => {
  it("markReviewed clears needs_review and points at the next paper to review", () => {
    const first = updateSubmission(seedSubmission(assignment.id).id, { status: "needs_review", flags: ["low_confidence"] });
    const second = updateSubmission(seedSubmission(assignment.id).id, { status: "needs_review", flags: ["low_confidence"] });

    expect(markReviewed(first)).toEqual({ nextId: second.id });
    expect(getSubmission(first.id)).toMatchObject({ status: "graded", reviewedAt: T0, flags: ["low_confidence"] });
    expect(markReviewed(second)).toEqual({ nextId: null });
  });

  it("markReviewed leaves a graded paper alone and refuses one that is not graded", () => {
    const graded = updateSubmission(seedSubmission(assignment.id).id, { status: "graded" });
    expect(markReviewed(graded)).toEqual({ nextId: null });
    expect(getSubmission(graded.id)!.reviewedAt).toBeNull();
    expect(() => markReviewed(seedSubmission(assignment.id))).toThrow(expect.objectContaining({ code: "invalid_state" }));
  });

  it("gradeManually sends a failed paper to review", () => {
    const failed = updateSubmission(seedSubmission(assignment.id).id, {
      status: "failed", errorCode: "invalid_output", errorMessage: "The AI returned an unusable answer several times.",
    });
    gradeManually(failed);
    expect(getSubmission(failed.id)).toMatchObject({
      status: "needs_review", flags: ["manual_grading"], scoreEarnedCenti: 0, scoreMaxCenti: 300, errorCode: null, errorMessage: null,
    });
    expect(() => gradeManually(failed)).toThrow(expect.objectContaining({ code: "invalid_state" }));
  });

  it("regradeSubmission starts a new generation, keeps overrides and queues a regrade job", async () => {
    const s = await gradedPaper();
    saveItemOverride(s, items[0].id, { pointsCenti: 40, feedback: null });

    regradeSubmission(s);

    expect(getSubmission(s.id)).toMatchObject({ status: "queued", gradingGeneration: 2, reviewedAt: null });
    expect(listItems(s.id)[0].overrideCenti).toBe(40);
    expect(jobRows(s.id)).toMatchObject([{ status: "done" }, { status: "queued", priority: PRIORITY.regrade }]);
    expect(() => regradeSubmission(s)).toThrow(expect.objectContaining({ code: "invalid_state" }));
  });

  it("retryFailed and regradeStale requeue only the matching papers", () => {
    const failed = updateSubmission(seedSubmission(assignment.id).id, { status: "failed" });
    const queued = seedSubmission(assignment.id);
    expect(retryFailed(assignment)).toBe(1);
    expect(getSubmission(failed.id)!.status).toBe("queued");
    expect(getSubmission(queued.id)!.gradingGeneration).toBe(1);

    expect(regradeStale(assignment)).toBe(0);
  });

  it("retryFailed and regradeStale leave earlier attempts the board folds away", () => {
    const earlierFailed = mariaLopezPaper("failed", 1);
    const current = mariaLopezPaper("graded", 2);
    expect(retryFailed(assignment)).toBe(0);
    expect(getSubmission(earlierFailed)!.status).toBe("failed");

    // Both graded against revision 1; a key edit makes them stale, but only the current one is regraded.
    updateSubmission(earlierFailed, { status: "graded" });
    getDb().prepare("UPDATE submissions SET graded_key_revision = 1").run();
    updateKey(assignment.id, { revision: 2, approvedRevision: 2 });
    expect(regradeStale(assignment)).toBe(1);
    expect(getSubmission(current)!.status).toBe("queued");
    expect(getSubmission(earlierFailed)!.status).toBe("graded");
  });

  it("regradeWithGuidance requeues only current, unreviewed, uncorrected papers graded with other guidance against the current key", async () => {
    let minute = 0;
    /** A graded paper the teacher named `name` (regrades keep it), submitted a minute after the previous one. */
    const named = async (name: string, label: string) => {
      const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [await pdfFile(label)]);
      await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));
      const { id } = byReceipt(receiptUrl);
      updateIdentity(getSubmission(id)!, { studentName: name, sectionId: null });
      getDb().prepare("UPDATE submissions SET created_at = ? WHERE id = ?").run(T0 + ++minute * 60_000, id);
      return getSubmission(id)!;
    };
    const anaEarlier = await named("Ana Ruiz", "ana-1");
    const reviewed = await named("Ben Ode", "ben");
    const keyStale = await named("Cy Moss", "cy");
    const fresh = await named("Dee Park", "dee");
    const ana = await named("Ana Ruiz", "ana-2");
    const corrected = await named("Eve Lund", "eve");
    const totalSet = await named("Fay Ng", "fay");
    expect(regradeWithGuidance(assignment)).toBe(0); // everything was graded with the current (empty) guidance

    updateSubmission(reviewed.id, { reviewedAt: T0 });
    getDb().prepare("UPDATE submissions SET graded_key_revision = 0 WHERE id = ?").run(keyStale.id);
    // Papers the teacher corrected (their correction becomes a lesson) count as checked: a regrade would re-judge
    // the items the teacher accepted on them.
    saveItemOverride(corrected, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half credit without units." });
    setTotalOverride(totalSet, 250);
    setGradingPreferences(assignment.teacherId, "Ignore spelling.");

    expect(regradeWithGuidance(assignment)).toBe(2);
    for (const id of [fresh.id, ana.id]) {
      expect(getSubmission(id)).toMatchObject({ status: "queued", gradingGeneration: 2 });
      expect(jobRows(id).at(-1)).toMatchObject({ status: "queued", priority: PRIORITY.regrade });
    }
    for (const id of [anaEarlier.id, reviewed.id, keyStale.id, corrected.id, totalSet.id]) {
      expect(getSubmission(id)!.gradingGeneration).toBe(1);
    }
    expect(getSubmission(corrected.id)!.status).toBe("graded");

    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs)));
    const { fingerprint } = loadGuidance(assignment);
    expect(getSubmission(fresh.id)!.gradedGuidanceFp).toBe(fingerprint);
    expect(getSubmission(ana.id)!.gradedGuidanceFp).toBe(fingerprint);
    expect(regradeWithGuidance(assignment)).toBe(0);
  });

  it("deleteSubmission removes the row, its queued job and its file", async () => {
    const { receiptUrl } = await ingestStudentUpload(assignment.shareCode, [await pdfFile("maria")]);
    const s = byReceipt(receiptUrl);

    await deleteSubmission(s);

    expect(getSubmission(s.id)).toBeNull();
    expect(jobRows(s.id)).toMatchObject([{ status: "cancelled" }]);
    expect(storedFiles(assignment)).toEqual([]);
  });

  it("deleteSubmission keeps the lessons from the teacher's corrections on the paper, no longer linked to it", async () => {
    const s = await gradedPaper();
    saveItemOverride(s, items[0].id, { pointsCenti: 50, feedback: null, reason: "Half credit without units." });

    await deleteSubmission(getSubmission(s.id)!);

    expect(listLessons(assignment.id)).toEqual([expect.objectContaining({ submissionId: null, reason: "Half credit without units." })]);
    expect(loadGuidance(assignment).sentIds).toHaveLength(1);
  });
});

describe("a regrade overwrites AI judgments only", () => {
  it("keeps an edited overall feedback through a regrade", async () => {
    const s = await gradedPaper();
    setOverallFeedback(s, "Teacher's words.");
    regradeSubmission(s);
    await drainQueue(answeringGrader((refs) => makeGradingOutput(refs, {
      items: refs.map((ref) => makeOutputItem(ref, { correctness: "incorrect" })), overall_feedback: "AI words.",
    })));

    expect(getSubmission(s.id)).toMatchObject({ overallFeedback: "Teacher's words.", status: "graded", scoreEarnedCenti: 300 });
  });
});
