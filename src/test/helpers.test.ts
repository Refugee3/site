import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { getKey, listKeyItems } from "@/lib/db/repos/keys";
import { listSections } from "@/lib/db/repos/assignments";
import {
  ENCRYPTED_PDF, ONE_PAGE_PDF, TINY_JPEG, TINY_PNG, makePdf, seedApprovedKey, seedAssignment, seedSubmission, seedTeacher,
  useTestDb,
} from "@/test/helpers";

describe("PDF and image fixtures", () => {
  it("ONE_PAGE_PDF is a valid one-page PDF", async () => {
    const doc = await PDFDocument.load(ONE_PAGE_PDF, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    expect(doc.isEncrypted).toBe(false);
  });

  it("ENCRYPTED_PDF reports isEncrypted when loaded with ignoreEncryption, and is refused otherwise", async () => {
    const doc = await PDFDocument.load(ENCRYPTED_PDF, { ignoreEncryption: true, updateMetadata: false });
    expect(doc.isEncrypted).toBe(true);
    expect(doc.getPageCount()).toBe(1);
    await expect(PDFDocument.load(ENCRYPTED_PDF)).rejects.toThrow(/encrypted/i);
  });

  it("makePdf builds the requested number of pages, deterministically", async () => {
    const bytes = await makePdf(3);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
    expect(await makePdf(3)).toEqual(bytes);
    expect(await makePdf(3, { label: "Other" })).not.toEqual(bytes);
  });

  it("TINY_JPEG and TINY_PNG are embeddable images", async () => {
    expect([...TINY_JPEG.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...TINY_PNG.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const doc = await PDFDocument.create();
    const jpg = await doc.embedJpg(TINY_JPEG);
    const png = await doc.embedPng(TINY_PNG);
    expect([jpg.width, jpg.height]).toEqual([4, 3]);
    expect([png.width, png.height]).toEqual([3, 4]);
  });
});

describe("seed helpers", () => {
  it("seed an assignment with sections, an approved key and submissions", () => {
    useTestDb();
    const teacher = seedTeacher();
    const assignment = seedAssignment(teacher.id, {
      status: "open", gradingMode: "accuracy", sections: [{ label: "Period 1", aliases: ["P1"], canonicalKey: "1" }],
    });
    expect(assignment).toMatchObject({ teacherId: teacher.id, status: "open", gradingMode: "accuracy" });
    expect(listSections(assignment.id).map((s) => [s.label, s.aliases, s.canonicalKey])).toEqual([["Period 1", ["P1"], "1"]]);

    const items = seedApprovedKey(assignment.id, [{}, { label: "2b", answerType: "numeric", pointsCenti: 250 }]);
    expect(items.map((i) => [i.label, i.answerType, i.pointsCenti, i.partialCredit, i.answerSource])).toEqual([
      ["1", "short_answer", 100, true, "teacher"], ["2b", "numeric", 250, true, "teacher"],
    ]);
    expect(listKeyItems(assignment.id)).toEqual(items);
    expect(getKey(assignment.id)).toMatchObject({ status: "ready", revision: 1, approvedRevision: 1 });

    const graded = seedSubmission(assignment.id, { status: "graded", source: "teacher" });
    expect(graded).toMatchObject({ status: "graded", source: "teacher", pageCount: 1 });
    expect(seedSubmission(assignment.id).contentSha256).not.toBe(graded.contentSha256);
  });

  it("seedSubmission with writeFile puts a PDF at its data path", () => {
    useTestDb();
    const assignment = seedAssignment(seedTeacher().id);
    const s = seedSubmission(assignment.id, { writeFile: true });

    expect(s.pdfPath).toBe(`files/${assignment.id}/submissions/${s.id}.pdf`);
    const file = path.join(getConfig().dataDir, s.pdfPath);
    expect(new Uint8Array(fs.readFileSync(file))).toEqual(ONE_PAGE_PDF);
    expect(s.byteSize).toBe(ONE_PAGE_PDF.length);
  });
});
