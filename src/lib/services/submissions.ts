import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { getAssignment, getAssignmentByShareCode, listSections } from "@/lib/db/repos/assignments";
import { cancelQueuedJobs } from "@/lib/db/repos/jobs";
import { listKeyItems } from "@/lib/db/repos/keys";
import {
  countSubmissions, deleteSubmissionRow, findBySha, getSubmission, insertSubmission, listIdsByStatus, listItems,
  listItemsForAssignment, listStaleIds, listSubmissions, requeueForRegrade, setItemOverride, updateSubmission,
} from "@/lib/db/repos/submissions";
import { AppError, isAppError } from "@/lib/errors";
import { IDENTITY_FLAGS, statusFromFlags } from "@/lib/flags";
import { nextNeedsReview, organizeBoard } from "@/lib/grading/board";
import { cleanName, nameKey, nameSortKey } from "@/lib/grading/names";
import { identityFlags } from "@/lib/grading/reconcile";
import { computeScore } from "@/lib/grading/scoring";
import { resolveSection } from "@/lib/grading/sections";
import { charLength } from "@/lib/grading/text";
import { newId, newToken, sha256Hex } from "@/lib/ids";
import { enqueueGrade, PRIORITY } from "@/lib/jobs/queue";
import { loadKeyState, requireKey } from "@/lib/services/key-state";
import { removeDataFile, writeFileAtomic } from "@/lib/storage/files";
import { submissionPdfRel } from "@/lib/storage/paths";
import { buildSubmissionPdf, sanitizeFilename, validatePdf, type UploadedFile } from "@/lib/storage/pdf";
import {
  FLAG_CODES,
  type Assignment, type FlagCode, type KeyItem, type Submission, type SubmissionItem, type SubmissionStatus,
} from "@/lib/types";

const MAX_STUDENT_NAME = 120;
const MAX_OVERALL_FEEDBACK = 2000;
const MAX_POINTS_CENTI = 100_000;
const REGRADABLE: ReadonlySet<SubmissionStatus> = new Set(["graded", "needs_review", "failed"]);

// ---------------------------------------------------------------------------------------------
// Ingest (§8 "Upload validation" steps 6–7)

interface StoredPdf {
  bytes: Uint8Array;
  pageCount: number;
  contentSha256: string;
}

/** A student upload through the share link. An exact replay of an earlier student upload returns that receipt. */
export async function ingestStudentUpload(code: string, files: UploadedFile[]): Promise<{ receiptUrl: string; duplicate: boolean }> {
  const assignment = getAssignmentByShareCode(code);
  if (!assignment) throw new AppError("not_found", "This assignment link is not valid.");
  assertOpenForStudents(assignment);

  const pdf = await buildSubmissionPdf(files, { maxPages: getConfig().maxPages });
  const earlier = checkContentSha(assignment.id, pdf.contentSha256, "student");
  if (earlier) return studentReplay(earlier);

  let submission: Submission;
  try {
    submission = await storeSubmission(assignment.id, "student", pdf, uploadName(files), assertOpenForStudents);
  } catch (e) {
    // A double tap sends the same bytes twice at once: the slower request gets the faster one's receipt.
    const winner = isAppError(e) && e.code === "duplicate" ? checkContentSha(assignment.id, pdf.contentSha256, "student") : null;
    if (winner) return studentReplay(winner);
    throw e;
  }
  return { receiptUrl: receiptUrl(submission.receiptToken, ""), duplicate: false };
}

/** One scanned paper (one PDF = one student) uploaded by the teacher; needs an approved key, whatever the assignment status. */
export async function ingestTeacherUpload(a: Assignment, file: UploadedFile, origin: string): Promise<{ submissionId: string; receiptUrl: string }> {
  assertKeyApproved(a);
  const { pageCount } = await validatePdf(file.bytes, { maxPages: getConfig().maxPages });
  const contentSha256 = sha256Hex(file.bytes);
  checkContentSha(a.id, contentSha256, "teacher");
  const submission = await storeSubmission(
    a.id, "teacher", { bytes: file.bytes, pageCount, contentSha256 }, sanitizeFilename(file.filename), assertKeyApproved,
  );
  return { submissionId: submission.id, receiptUrl: receiptUrl(submission.receiptToken, origin) };
}

function assertOpenForStudents(a: Assignment): void {
  if (a.status !== "open") throw new AppError("closed", "This assignment is not accepting submissions right now.");
}

function assertKeyApproved(a: Assignment): void {
  if (!loadKeyState(a.id).approved) {
    throw new AppError("key_not_ready", "Approve the answer key before uploading papers.");
  }
}

/**
 * Rejects the answer key itself and exact duplicates. Returns the earlier submission when a student
 * re-sends exactly what an earlier student upload contained (a retry after a dropped connection).
 */
function checkContentSha(assignmentId: string, sha: string, source: Submission["source"]): Submission | null {
  if (requireKey(assignmentId).sourceSha256 === sha) {
    throw new AppError("is_answer_key", "This file is the answer key, not a student's paper.");
  }
  const existing = findBySha(assignmentId, sha);
  if (!existing) return null;
  if (source === "student" && existing.source === "student") return existing;
  throw new AppError("duplicate", "This exact file was already submitted for this assignment.");
}

function studentReplay(s: Submission): { receiptUrl: string; duplicate: boolean } {
  return { receiptUrl: receiptUrl(s.receiptToken, ""), duplicate: true };
}

function uploadName(files: UploadedFile[]): string {
  const first = sanitizeFilename(files[0]?.filename ?? "");
  return files.length > 1 ? `${first} + ${files.length - 1} more` : first;
}

/**
 * Writes the PDF first, then inserts the row and queues its grading job in one transaction that
 * re-checks the assignment; if the transaction fails the file is removed again.
 */
async function storeSubmission(
  assignmentId: string,
  source: Submission["source"],
  pdf: StoredPdf,
  originalFilename: string,
  assertStillAccepting: (a: Assignment) => void,
): Promise<Submission> {
  const id = newId();
  const pdfPath = submissionPdfRel(assignmentId, id);
  await writeFileAtomic(pdfPath, pdf.bytes);
  try {
    return tx(() => {
      const assignment = getAssignment(assignmentId);
      if (!assignment) throw new AppError("not_found", "This assignment no longer exists.");
      assertStillAccepting(assignment);
      if (countSubmissions(assignmentId) >= assignment.maxSubmissions) {
        throw new AppError("submission_limit", "This assignment has reached its submission limit. Ask your teacher.");
      }
      const submission = insertSubmission({
        id,
        assignmentId,
        source,
        receiptToken: newToken(),
        pdfPath,
        originalFilename,
        contentSha256: pdf.contentSha256,
        byteSize: pdf.bytes.byteLength,
        pageCount: pdf.pageCount,
      });
      enqueueGrade(id, assignmentId, source === "student" ? PRIORITY.student : PRIORITY.teacher);
      return submission;
    });
  } catch (e) {
    await removeDataFile(pdfPath);
    throw e;
  }
}

/** `${origin}/r/<token>`; an empty origin gives the relative link. */
export function receiptUrl(token: string, origin: string): string {
  return `${origin}/r/${token}`;
}

// ---------------------------------------------------------------------------------------------
// Teacher edits

export function saveItemOverride(s: Submission, itemId: string, p: { pointsCenti: number | null; feedback: string | null }): void {
  assertPoints(p.pointsCenti);
  tx(() => {
    if (!listKeyItems(s.assignmentId).some((item) => item.id === itemId)) {
      throw new AppError("not_found", "This question is no longer in the answer key.");
    }
    setItemOverride(s.id, itemId, { overrideCenti: p.pointsCenti, overrideFeedback: p.feedback });
    rescoreSubmission(s.id);
  });
}

export function setTotalOverride(s: Submission, centi: number | null): void {
  assertPoints(centi);
  tx(() => {
    updateSubmission(s.id, { totalOverrideCenti: centi });
    rescoreSubmission(s.id);
  });
}

function assertPoints(centi: number | null): void {
  if (centi !== null && !(Number.isInteger(centi) && centi >= 0 && centi <= MAX_POINTS_CENTI)) {
    throw new AppError("validation", "Points must be a number between 0 and 1000 with at most two decimals.");
  }
}

/** The teacher's version of the overall feedback; regrades keep it from now on. */
export function setOverallFeedback(s: Submission, text: string): void {
  const overallFeedback = text.trim();
  if (charLength(overallFeedback) > MAX_OVERALL_FEEDBACK) {
    const message = `Use at most ${MAX_OVERALL_FEEDBACK} characters.`;
    throw new AppError("validation", message, { fieldErrors: { overallFeedback: [message] } });
  }
  updateSubmission(s.id, { overallFeedback, overallFeedbackEdited: true });
}

/** The teacher sets name and section; both then count as teacher-set, so regrades keep them and they raise no flags. */
export function updateIdentity(s: Submission, i: { studentName: string; sectionId: string | null }): void {
  if (charLength(i.studentName.trim()) > MAX_STUDENT_NAME) {
    const message = `Use at most ${MAX_STUDENT_NAME} characters.`;
    throw new AppError("validation", message, { fieldErrors: { studentName: [message] } });
  }
  tx(() => {
    const current = requireSubmission(s.id);
    const sections = listSections(current.assignmentId);
    if (i.sectionId !== null && !sections.some((section) => section.id === i.sectionId)) {
      const message = "Choose one of this assignment's sections.";
      throw new AppError("validation", message, { fieldErrors: { sectionId: [message] } });
    }
    const studentName = cleanName(i.studentName);
    const identity = {
      studentName,
      nameSource: "teacher" as const,
      nameKey: nameKey(studentName),
      nameSortKey: nameSortKey(studentName),
      sectionId: i.sectionId,
      sectionSource: "teacher" as const,
    };
    const flags = replaceIdentityFlags(current.flags, identityFlags({ ...current, ...identity }, "teacher", sections.length > 0));
    updateSubmission(current.id, { ...identity, flags, ...statusAfterFlagChange(current, flags) });
  });
}

/** Clears a needs_review paper (graded papers are left alone) and finds the next paper to review in board order. */
export function markReviewed(s: Submission): { nextId: string | null } {
  return tx(() => {
    const current = requireSubmission(s.id);
    if (current.status === "needs_review") {
      updateSubmission(current.id, { status: "graded", reviewedAt: now() });
    } else if (current.status !== "graded") {
      throw new AppError("invalid_state", "Only a graded paper can be marked reviewed.");
    }
    const groups = organizeBoard(listSubmissions(current.assignmentId), listSections(current.assignmentId));
    return { nextId: nextNeedsReview(groups, current.id) };
  });
}

/** A paper the AI could not grade goes to the teacher, who enters points with overrides. */
export function gradeManually(s: Submission): void {
  tx(() => {
    const current = requireSubmission(s.id);
    if (current.status !== "failed") {
      throw new AppError("invalid_state", "Only a paper whose grading failed can be graded manually.");
    }
    updateSubmission(current.id, {
      status: "needs_review", statusNote: null, flags: ["manual_grading"], errorCode: null, errorMessage: null,
    });
    rescoreSubmission(current.id);
  });
}

export function regradeSubmission(s: Submission): void {
  tx(() => {
    const current = requireSubmission(s.id);
    if (!REGRADABLE.has(current.status)) {
      throw new AppError("invalid_state", "This paper is already waiting to be graded.");
    }
    requeueForGrading(current.id, current.assignmentId);
  });
}

/** Regrades every paper graded against an older key revision; returns how many. */
export function regradeStale(a: Assignment): number {
  return tx(() => requeueAll(a.id, listStaleIds(a.id, requireKey(a.id).revision)));
}

/** Retries every failed paper; returns how many. */
export function retryFailed(a: Assignment): number {
  return tx(() => requeueAll(a.id, listIdsByStatus(a.id, ["failed"])));
}

function requeueAll(assignmentId: string, submissionIds: string[]): number {
  for (const id of submissionIds) requeueForGrading(id, assignmentId);
  return submissionIds.length;
}

/** A new grading generation (so any running result is discarded) plus its job. Overrides are kept. */
function requeueForGrading(submissionId: string, assignmentId: string): void {
  requeueForRegrade(submissionId);
  enqueueGrade(submissionId, assignmentId, PRIORITY.regrade);
}

export async function deleteSubmission(s: Submission): Promise<void> {
  tx(() => {
    cancelQueuedJobs("grade_submission", s.id);
    deleteSubmissionRow(s.id);
  });
  await removeDataFile(s.pdfPath);
}

function requireSubmission(id: string): Submission {
  const submission = getSubmission(id);
  if (!submission) throw new AppError("not_found", "This paper no longer exists.");
  return submission;
}

// ---------------------------------------------------------------------------------------------
// Derived state: scores, sections, flags

/** Recomputes the cached score columns from the current key, judgments and overrides. Never calls the AI. */
export function rescoreSubmission(submissionId: string): void {
  tx(() => {
    const submission = getSubmission(submissionId);
    const assignment = submission && getAssignment(submission.assignmentId);
    if (!submission || !assignment) return;
    writeScore(submission, assignment, listKeyItems(assignment.id), listItems(submission.id));
  });
}

export function rescoreAssignment(assignmentId: string): void {
  tx(() => {
    const assignment = getAssignment(assignmentId);
    if (!assignment) return;
    const items = listKeyItems(assignmentId);
    const results = listItemsForAssignment(assignmentId);
    for (const submission of listSubmissions(assignmentId)) {
      writeScore(submission, assignment, items, results.get(submission.id) ?? []);
    }
  });
}

function writeScore(s: Submission, a: Assignment, items: KeyItem[], results: SubmissionItem[]): void {
  const score = computeScore(items, new Map(results.map((r) => [r.itemId, r])), a, s.totalOverrideCenti);
  updateSubmission(s.id, {
    scoreEarnedCenti: score.earnedCenti,
    scoreMaxCenti: score.maxCenti,
    completionCenti: score.completionCenti,
    accuracyCenti: score.accuracyCenti,
  });
}

/** Re-resolves the AI-read section of every paper after the teacher changed the section list. */
export function rematchSections(assignmentId: string): void {
  tx(() => {
    const sections = listSections(assignmentId);
    for (const s of listSubmissions(assignmentId)) {
      // A teacher's choice stands, and a paper the AI has not read yet has nothing to match.
      if (s.sectionSource === "teacher" || s.gradedAt === null) continue;
      const match = resolveSection(s.aiSectionRaw, s.aiSectionMatch, sections);
      const sectionId = "sectionId" in match ? match.sectionId : null;
      const section = { sectionId, sectionSource: sectionId ? ("ai" as const) : null };
      const flags = replaceIdentityFlags(s.flags, identityFlags({ ...s, ...section }, match.kind, sections.length > 0));
      updateSubmission(s.id, { ...section, flags, ...statusAfterFlagChange(s, flags) });
    }
  });
}

/** Swaps the identity flags for freshly computed ones, keeping FLAG_CODES order. */
function replaceIdentityFlags(flags: FlagCode[], identity: FlagCode[]): FlagCode[] {
  const present = new Set([...flags.filter((flag) => !IDENTITY_FLAGS.has(flag)), ...identity]);
  return FLAG_CODES.filter((code) => present.has(code));
}

/** §1.3: graded papers follow their flags; queued, grading and failed papers keep their status. */
function statusAfterFlagChange(s: Submission, flags: FlagCode[]): { status?: "graded" | "needs_review" } {
  return s.status === "graded" || s.status === "needs_review" ? { status: statusFromFlags(flags, s.reviewedAt) } : {};
}
