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
import { formatPoints } from "@/lib/format";
import { boardOrderIds, nextNeedsReview, organizeBoard } from "@/lib/grading/board";
import { cleanName, nameKey, nameSortKey } from "@/lib/grading/names";
import { identityFlags } from "@/lib/grading/reconcile";
import { computeScore, MAX_ITEM_POINTS_CENTI } from "@/lib/grading/scoring";
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
const MAX_ITEM_NOTE = 1000;
const REGRADABLE: ReadonlySet<SubmissionStatus> = new Set(["graded", "needs_review", "failed"]);

// ---------------------------------------------------------------------------------------------
// Ingest: the steps after the route's cheap checks (build the PDF, content-hash duplicate checks, atomic
// file write, then insert and enqueue in one transaction)

interface StoredPdf {
  bytes: Uint8Array;
  pageCount: number;
  contentSha256: string;
  clientUploadId?: string | null;
}

/**
 * A student upload through the share link. `clientUploadId` is the id the browser sends with one
 * upload (and again when it retries it); only a re-send with the same id gets the earlier receipt back.
 */
export async function ingestStudentUpload(
  code: string,
  files: UploadedFile[],
  clientUploadId: string | null = null,
): Promise<{ receiptUrl: string; duplicate: boolean }> {
  const assignment = getAssignmentByShareCode(code);
  if (!assignment) throw new AppError("not_found", "This assignment link is not valid.");
  assertOpenForStudents(assignment);

  const pdf = await buildSubmissionPdf(files, { maxPages: getConfig().maxPages });
  const earlier = checkContentSha(assignment.id, pdf.contentSha256, { source: "student", clientUploadId });
  if (earlier) return studentReplay(earlier);

  let submission: Submission;
  try {
    submission = await storeSubmission(assignment.id, "student", { ...pdf, clientUploadId }, uploadName(files), assertOpenForStudents);
  } catch (e) {
    // A double tap sends the same upload twice at once: the slower request gets the faster one's receipt.
    const winner = isAppError(e) && e.code === "duplicate"
      ? checkContentSha(assignment.id, pdf.contentSha256, { source: "student", clientUploadId })
      : null;
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
  checkContentSha(a.id, contentSha256, { source: "teacher", clientUploadId: null });
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
 * Rejects the answer key itself and exact duplicates. Returns the earlier submission when the same
 * browser re-sends the same upload (a retry after a dropped connection, or a double tap). Anyone else
 * sending the same bytes, a classmate with a shared PDF for instance, gets `duplicate` and never
 * another student's receipt.
 */
function checkContentSha(
  assignmentId: string,
  sha: string,
  upload: { source: Submission["source"]; clientUploadId: string | null },
): Submission | null {
  if (requireKey(assignmentId).sourceSha256 === sha) {
    throw new AppError("is_answer_key", "This file is the answer key, not a student's paper.");
  }
  const existing = findBySha(assignmentId, sha);
  if (!existing) return null;
  const sameUpload = upload.source === "student" && existing.source === "student" && upload.clientUploadId !== null
    && existing.clientUploadId === upload.clientUploadId;
  if (sameUpload) return existing;
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
        clientUploadId: pdf.clientUploadId ?? null,
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

/**
 * The teacher's points, feedback and (optionally) "what you did" note for one item; null clears an
 * override, and an omitted `whatStudentDid` leaves that note as it is. "" hides the note from the student.
 */
export function saveItemOverride(
  s: Submission,
  itemId: string,
  p: { pointsCenti: number | null; feedback: string | null; whatStudentDid?: string | null },
): void {
  if (p.pointsCenti !== null && !(Number.isInteger(p.pointsCenti) && p.pointsCenti >= 0 && p.pointsCenti <= MAX_ITEM_POINTS_CENTI)) {
    throw new AppError("validation", `Points must be a number between 0 and ${formatPoints(MAX_ITEM_POINTS_CENTI)} with at most two decimals.`);
  }
  const whatStudentDid = p.whatStudentDid === undefined || p.whatStudentDid === null ? p.whatStudentDid : p.whatStudentDid.trim();
  if (whatStudentDid && charLength(whatStudentDid) > MAX_ITEM_NOTE) {
    throw new AppError("validation", `Use at most ${MAX_ITEM_NOTE} characters for what the student did.`);
  }
  tx(() => {
    if (!listKeyItems(s.assignmentId).some((item) => item.id === itemId)) {
      throw new AppError("not_found", "This question is no longer in the answer key.");
    }
    setItemOverride(s.id, itemId, { overrideCenti: p.pointsCenti, overrideFeedback: p.feedback, overrideWhatStudentDid: whatStudentDid });
    rescoreSubmission(s.id);
  });
}

/** The teacher's total for the paper; scoring clamps it to the key's total, so only the shape is checked here. */
export function setTotalOverride(s: Submission, centi: number | null): void {
  const maxTotal = MAX_ITEM_POINTS_CENTI * getConfig().maxKeyItems;
  if (centi !== null && !(Number.isInteger(centi) && centi >= 0 && centi <= maxTotal)) {
    throw new AppError("validation", "The total must be a number of points, 0 or more, with at most two decimals.");
  }
  tx(() => {
    updateSubmission(s.id, { totalOverrideCenti: centi });
    rescoreSubmission(s.id);
  });
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

/**
 * The teacher sets name and section; both then count as teacher-set, so regrades keep them and they
 * raise no flags. Without configured sections there is no section to choose, so the section is left
 * as the AI read it (and a section list added later can still place the paper).
 */
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
    const hasSections = sections.length > 0;
    const identity = {
      studentName,
      nameSource: "teacher" as const,
      nameKey: nameKey(studentName),
      nameSortKey: nameSortKey(studentName),
      ...(hasSections ? { sectionId: i.sectionId, sectionSource: "teacher" as const } : {}),
    };
    const flags = replaceIdentityFlags(current.flags, identityFlags({ ...current, ...identity }, hasSections ? "teacher" : "unconfigured", hasSections));
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

/**
 * Regrades every current paper graded against an older key revision; returns how many. Earlier
 * attempts the board folds under a newer one are left alone (regrading them is a paid call nobody sees).
 */
export function regradeStale(a: Assignment): number {
  return tx(() => requeueAll(a.id, currentOnly(a.id, listStaleIds(a.id, requireKey(a.id).revision))));
}

/** Retries every current paper whose grading failed; returns how many. */
export function retryFailed(a: Assignment): number {
  return tx(() => requeueAll(a.id, currentOnly(a.id, listIdsByStatus(a.id, ["failed"]))));
}

/** The ids that are current papers on the board (not folded earlier attempts), in the given order. */
export function currentOnly(assignmentId: string, ids: string[]): string[] {
  const current = new Set(boardOrderIds(organizeBoard(listSubmissions(assignmentId), listSections(assignmentId))));
  return ids.filter((id) => current.has(id));
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

/** Graded papers follow their flags; queued, grading and failed papers keep their status. */
function statusAfterFlagChange(s: Submission, flags: FlagCode[]): { status?: "graded" | "needs_review" } {
  return s.status === "graded" || s.status === "needs_review" ? { status: statusFromFlags(flags, s.reviewedAt) } : {};
}
