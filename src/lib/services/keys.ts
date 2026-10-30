import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { cancelQueuedJobs } from "@/lib/db/repos/jobs";
import { deleteKeyQuestions, skipPendingKeyQuestions } from "@/lib/db/repos/key-questions";
import { listKeyItems, setGradedItems, updateKey, upsertKeyItems } from "@/lib/db/repos/keys";
import { listStaleIds } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { keyFingerprint, LIMITS as KEY_LIMITS, validateSaveKey } from "@/lib/grading/key";
import { charLength } from "@/lib/grading/text";
import { newId } from "@/lib/ids";
import { enqueueExtractKey } from "@/lib/jobs/queue";
import { isKeyLocked, requireKey } from "@/lib/services/key-state";
import { rescoreAssignment } from "@/lib/services/submissions";
import { removeDataFile, writeFileAtomic } from "@/lib/storage/files";
import { keyPdfRel } from "@/lib/storage/paths";
import { buildSubmissionPdf, uploadName, type UploadedFile } from "@/lib/storage/pdf";
import type { AnswerKey, Assignment, SaveKeyInput } from "@/lib/types";

/**
 * Stores a (replacement) key and queues its extraction. The uploaded files (any accepted format) are merged
 * into one PDF. `instructions`, when given, become the key's grading instructions (teacher notes) before the AI reads it, so
 * the reading follows them (how questions split into parts, their points, what isn't graded); without them the teacher's
 * notes are kept. The old PDF is removed once the new one is committed.
 */
export async function ingestKeyPdf(a: Assignment, upload: UploadedFile | UploadedFile[], instructions?: string): Promise<AnswerKey> {
  const teacherNotes = instructions === undefined ? undefined : checkedInstructions(instructions);
  const files = [upload].flat();
  const { bytes, pageCount, contentSha256 } = await buildSubmissionPdf(files, { maxPages: getConfig().maxPages });
  assertExtractable(a.id); // fail before writing the file; re-checked in the transaction
  const pdfPath = keyPdfRel(a.id, newId());
  await writeFileAtomic(pdfPath, bytes);

  let stored: { key: AnswerKey; previousPdfPath: string | null };
  try {
    stored = tx(() => {
      const previous = assertExtractable(a.id);
      const key = updateKey(a.id, {
        status: "processing",
        sourcePdfPath: pdfPath,
        sourceFilename: uploadName(files),
        sourceSha256: contentSha256,
        sourcePageCount: pageCount,
        documentKind: null, // the previous PDF's verdict; this one has not been read yet
        errorMessage: null,
        processingStartedAt: now(),
        processingFinishedAt: null,
        ...(teacherNotes === undefined ? {} : { teacherNotes }),
      });
      deleteKeyQuestions(a.id); // the previous key's; this one's come with its reading
      queueExtraction(a.id);
      return { key, previousPdfPath: previous.sourcePdfPath };
    });
  } catch (e) {
    await removeDataFile(pdfPath);
    throw e;
  }
  if (stored.previousPdfPath) await removeDataFile(stored.previousPdfPath);
  return stored.key;
}

/** Reads the stored key PDF again (after a failure, or to start over from the PDF), with new `instructions` when given. */
export function retryKeyExtraction(a: Assignment, instructions?: string): void {
  const teacherNotes = instructions === undefined ? undefined : checkedInstructions(instructions);
  tx(() => {
    const key = assertExtractable(a.id);
    if (!key.sourcePdfPath) {
      throw new AppError("invalid_state", "There is no uploaded key PDF to read again. Upload one or build the key manually.");
    }
    updateKey(a.id, {
      status: "processing", errorMessage: null, processingStartedAt: now(), processingFinishedAt: null,
      ...(teacherNotes === undefined ? {} : { teacherNotes }),
    });
    deleteKeyQuestions(a.id);
    queueExtraction(a.id);
  });
}

/** Extraction replaces every key item, so it is refused while the key is being read or once papers were graded with it. */
function assertExtractable(assignmentId: string): AnswerKey {
  const key = requireKey(assignmentId);
  if (key.status === "processing") {
    throw new AppError("invalid_state", "The answer key is still being read. Wait for it to finish.");
  }
  if (isKeyLocked(assignmentId)) {
    throw new AppError("key_locked", "Papers have already been graded with this key, so it can't be replaced. Edit the key instead.");
  }
  return key;
}

function queueExtraction(assignmentId: string): void {
  cancelQueuedJobs("extract_key", assignmentId);
  enqueueExtractKey(assignmentId);
}

/**
 * Saves the teacher's edits, which also approves the key. Only a change to judgment-relevant content
 * (the fingerprint) starts a new revision and makes earlier grades stale; points and partial credit just rescore.
 */
export function saveKey(a: Assignment, input: SaveKeyInput): { revision: number; staleCount: number } {
  const { maxKeyItems } = getConfig();
  return tx(() => {
    const key = requireKey(a.id);
    if (key.status === "processing") {
      throw new AppError("invalid_state", "The answer key is still being read. Wait for it to finish before editing.");
    }
    const current = listKeyItems(a.id);
    const validated = validateSaveKey(input, current, { maxItems: maxKeyItems });
    if (!validated.ok) throw new AppError("validation", validated.error, { fieldErrors: validated.fieldErrors });

    const saved = upsertKeyItems(a.id, validated.items);
    const fingerprint = keyFingerprint(saved, validated.teacherNotes);
    // Leaving a question out just rescores; counting one again needs a regrade: papers graded without it have no answer for it.
    const wasSkipped = new Set(current.filter((item) => !item.graded).map((item) => item.id));
    const counted = saved.some((item) => item.graded && wasSkipped.has(item.id));
    const revision = fingerprint === key.fingerprint && !counted ? key.revision : key.revision + 1;
    updateKey(a.id, {
      teacherNotes: validated.teacherNotes,
      fingerprint,
      revision,
      approvedRevision: revision,
      status: "ready",
      errorMessage: null,
    });
    // Approved without answering them: the teacher checked the key themselves.
    skipPendingKeyQuestions(a.id);
    rescoreAssignment(a.id);
    const staleCount = listStaleIds(a.id, revision).length;
    return { revision, staleCount };
  });
}

/**
 * Saves the upload page's grading instructions (the key's teacher notes) and, when given, which questions count
 * (`gradedItemIds`). Like a key save, a changed instruction or a question counted again makes papers graded before stale, and
 * leaving a question out just rescores. An approved key stays approved (the teacher made the change); an unapproved one doesn't
 * become approved.
 */
export function saveGradingInstructions(
  a: Assignment,
  input: { text: string; gradedItemIds?: string[] },
): { changed: boolean; staleCount: number } {
  const teacherNotes = checkedInstructions(input.text);
  return tx(() => {
    const key = requireKey(a.id);
    if (key.status === "processing") {
      throw new AppError("invalid_state", "The answer key is still being read. Wait for it to finish.");
    }
    const current = listKeyItems(a.id);
    const wanted = input.gradedItemIds ? new Set(input.gradedItemIds) : null;
    if (wanted && !current.some((item) => wanted.has(item.id))) {
      throw new AppError("validation", "Keep at least one question counted in the grade.");
    }
    const flagsChange = wanted !== null && current.some((item) => item.graded !== wanted.has(item.id));
    if (teacherNotes === key.teacherNotes && !flagsChange) return { changed: false, staleCount: 0 };

    if (flagsChange) setGradedItems(a.id, wanted);
    const counted = wanted !== null && current.some((item) => !item.graded && wanted.has(item.id));
    const fingerprint = keyFingerprint(current, teacherNotes);
    const revision = fingerprint === key.fingerprint && !counted ? key.revision : key.revision + 1;
    const approved = key.approvedRevision === key.revision;
    updateKey(a.id, { teacherNotes, fingerprint, revision, ...(approved ? { approvedRevision: revision } : {}) });
    if (flagsChange) rescoreAssignment(a.id);
    return { changed: true, staleCount: approved ? listStaleIds(a.id, revision).length : 0 };
  });
}

function checkedInstructions(text: string): string {
  const trimmed = text.trim();
  if (charLength(trimmed) > KEY_LIMITS.teacherNotes) {
    throw new AppError("validation", `Keep the instructions to ${KEY_LIMITS.teacherNotes} characters or fewer.`);
  }
  return trimmed;
}
