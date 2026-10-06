import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getConfig } from "@/lib/config";
import { openDatabase, setDbForTests, type DB } from "@/lib/db/connection";
import { insertAssignment, replaceSections, shareCodeExists, updateAssignment } from "@/lib/db/repos/assignments";
import { createEmptyKey, replaceKeyItems, updateKey } from "@/lib/db/repos/keys";
import { insertSubmission, updateSubmission, type NewSubmission } from "@/lib/db/repos/submissions";
import { insertTeacher } from "@/lib/db/repos/teachers";
import { newId, newShareCode, newToken, sha256Hex } from "@/lib/ids";
import type { Assignment, KeyItem, NewKeyItem, Submission, SubmissionStatus, Teacher } from "@/lib/types";

/** A fresh migrated in-memory database installed as the shared connection (closed by the test setup). */
export function useTestDb(): DB {
  const db = openDatabase(":memory:");
  setDbForTests(db);
  return db;
}

export function seedTeacher(o: Partial<{ email: string; displayName: string }> = {}): Teacher {
  return insertTeacher({
    email: o.email ?? `teacher-${newId().slice(0, 8)}@example.com`,
    displayName: o.displayName ?? "Test Teacher",
    passwordHash: "scrypt$test$not-a-real-hash",
  });
}

function unusedShareCode(): string {
  let code = newShareCode();
  while (shareCodeExists(code)) code = newShareCode();
  return code;
}

/** An assignment with an empty key and, optionally, sections (callers supply canonical keys). */
export function seedAssignment(
  teacherId: string,
  o: Partial<Pick<Assignment, "title" | "status" | "gradingMode" | "accuracyWeight" | "maxSubmissions">>
    & { sections?: Array<{ label: string; aliases?: string[]; canonicalKey: string }> } = {},
): Assignment {
  const assignment = insertAssignment({
    id: newId(),
    teacherId,
    title: o.title ?? "Unit 4 Quiz",
    instructions: "",
    gradingMode: o.gradingMode ?? "completion",
    accuracyWeight: o.accuracyWeight ?? 50,
    shareCode: unusedShareCode(),
    maxSubmissions: o.maxSubmissions ?? 500,
  });
  createEmptyKey(assignment.id);
  if (o.sections) {
    replaceSections(assignment.id, o.sections.map((s) => ({ label: s.label, aliases: s.aliases ?? [], canonicalKey: s.canonicalKey })));
  }
  return o.status && o.status !== assignment.status ? updateAssignment(assignment.id, { status: o.status }) : assignment;
}

function defaultKeyItem(index: number): NewKeyItem {
  return {
    label: String(index + 1),
    groupLabel: "",
    prompt: "",
    answerType: "short_answer",
    expectedAnswer: "",
    acceptableAnswers: [],
    gradingCriteria: "",
    pointsCenti: 100,
    partialCredit: true,
    page: null,
    answerSource: "teacher",
    aiConfidence: null,
    aiNote: "",
  };
}

/** Replaces the key items and marks the key ready and approved at revision 1. */
export function seedApprovedKey(assignmentId: string, items: Array<Partial<NewKeyItem>>): KeyItem[] {
  const saved = replaceKeyItems(assignmentId, items.map((item, index) => ({ ...defaultKeyItem(index), ...item })));
  updateKey(assignmentId, { status: "ready", revision: 1, approvedRevision: 1, fingerprint: "test-fingerprint" });
  return saved;
}

/** A submission (queued unless `status` says otherwise); `writeFile` also puts a 1-page PDF at its pdfPath. */
export function seedSubmission(
  assignmentId: string,
  o: Partial<NewSubmission> & { status?: SubmissionStatus; writeFile?: boolean } = {},
): Submission {
  const { status, writeFile, ...overrides } = o;
  const id = overrides.id ?? newId();
  const pdfPath = overrides.pdfPath ?? `files/${assignmentId}/submissions/${id}.pdf`;
  const submission = insertSubmission({
    id,
    assignmentId,
    source: "student",
    receiptToken: newToken(),
    pdfPath,
    originalFilename: "submission.pdf",
    contentSha256: sha256Hex(id),
    byteSize: ONE_PAGE_PDF.length,
    pageCount: 1,
    ...overrides,
  });
  if (writeFile) {
    const file = path.join(getConfig().dataDir, pdfPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ONE_PAGE_PDF);
  }
  return status && status !== submission.status ? updateSubmission(id, { status }) : submission;
}

/** A valid PDF with `pages` letter-size pages, each labelled "<label> page N"; same arguments → same bytes. */
export async function makePdf(pages: number, o: { label?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    doc.addPage([612, 792]).drawText(`${o.label ?? "Test"} page ${n}`, { x: 72, y: 720, size: 18, font });
  }
  return doc.save();
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

/** 4×3 px baseline JPEG. */
export const TINY_JPEG = fromBase64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/"
  + "2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAADAAQDASIAAhEBAxEB/8QA"
  + "FQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oA"
  + "DAMBAAIRAxEAPwCWAEpn/9k=",
);

/** 3×4 px RGB PNG. */
export const TINY_PNG = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAAECAIAAADETxJQAAAAF0lEQVR42mM8oaHBwMDAwMDAxAAD2FgAKvgBIEaql5sAAAAASUVORK5CYII=",
);

/** Builds a classic PDF (header, numbered objects, xref table, trailer) with correct byte offsets. */
function assemblePdf(objects: string[], trailerEntries: string): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = body.length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("");
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerEntries}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body + xref + trailer);
}

const ONE_PAGE_OBJECTS = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
];

/** A minimal blank one-page PDF, available synchronously. */
export const ONE_PAGE_PDF = assemblePdf(ONE_PAGE_OBJECTS, "");

/** A one-page PDF whose trailer references a /Standard security handler, so pdf-lib reports isEncrypted. */
export const ENCRYPTED_PDF = assemblePdf(
  [
    ...ONE_PAGE_OBJECTS,
    `<< /Filter /Standard /V 1 /R 2 /O <${"28bf4e5e".repeat(8)}> /U <${"4e5e28bf".repeat(8)}> /P -44 >>`,
  ],
  `/Encrypt 4 0 R /ID [<${"0123456789abcdef".repeat(2)}> <${"0123456789abcdef".repeat(2)}>] `,
);
