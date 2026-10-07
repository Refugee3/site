import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { cancelQueuedJobs } from "@/lib/db/repos/jobs";
import { listKeyItems, updateKey, upsertKeyItems } from "@/lib/db/repos/keys";
import { listStaleIds } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { keyFingerprint, validateSaveKey } from "@/lib/grading/key";
import { newId, sha256Hex } from "@/lib/ids";
import { enqueueExtractKey } from "@/lib/jobs/queue";
import { setAssignmentStatus } from "@/lib/services/assignments";
import { isKeyLocked, requireKey } from "@/lib/services/key-state";
import { studentUploadsEnabled } from "@/lib/services/settings";
import { rescoreAssignment } from "@/lib/services/submissions";
import { removeDataFile, writeFileAtomic } from "@/lib/storage/files";
import { keyPdfRel } from "@/lib/storage/paths";
import { sanitizeFilename, validatePdf, type UploadedFile } from "@/lib/storage/pdf";
import type { AnswerKey, Assignment, SaveKeyInput } from "@/lib/types";

/**
 * Stores a (replacement) key PDF and queues its extraction. The teacher's notes are kept; the old
 * PDF is removed once the new one is committed.
 */
export async function ingestKeyPdf(a: Assignment, f: UploadedFile): Promise<AnswerKey> {
  const { pageCount } = await validatePdf(f.bytes, { maxPages: getConfig().maxPages });
  assertExtractable(a.id); // fail before writing the file; re-checked in the transaction
  const pdfPath = keyPdfRel(a.id, newId());
  await writeFileAtomic(pdfPath, f.bytes);

  let stored: { key: AnswerKey; previousPdfPath: string | null };
  try {
    stored = tx(() => {
      const previous = assertExtractable(a.id);
      const key = updateKey(a.id, {
        status: "processing",
        sourcePdfPath: pdfPath,
        sourceFilename: sanitizeFilename(f.filename),
        sourceSha256: sha256Hex(f.bytes),
        sourcePageCount: pageCount,
        documentKind: null, // the previous PDF's verdict; this one has not been read yet
        errorMessage: null,
      });
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

/** Reads the stored key PDF again (after a failure, or to start over from the PDF). */
export function retryKeyExtraction(a: Assignment): void {
  tx(() => {
    const key = assertExtractable(a.id);
    if (!key.sourcePdfPath) {
      throw new AppError("invalid_state", "There is no uploaded key PDF to read again. Upload one or build the key manually.");
    }
    updateKey(a.id, { status: "processing", errorMessage: null });
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
 * `open` opens the assignment for students only while student uploads are turned on.
 */
export function saveKey(a: Assignment, input: SaveKeyInput, o: { open: boolean }): { revision: number; staleCount: number } {
  const { maxKeyItems } = getConfig();
  return tx(() => {
    const key = requireKey(a.id);
    if (key.status === "processing") {
      throw new AppError("invalid_state", "The answer key is still being read. Wait for it to finish before editing.");
    }
    const validated = validateSaveKey(input, listKeyItems(a.id), { maxItems: maxKeyItems });
    if (!validated.ok) throw new AppError("validation", validated.error, { fieldErrors: validated.fieldErrors });

    const saved = upsertKeyItems(a.id, validated.items);
    const fingerprint = keyFingerprint(saved, validated.teacherNotes);
    const revision = fingerprint === key.fingerprint ? key.revision : key.revision + 1;
    updateKey(a.id, {
      teacherNotes: validated.teacherNotes,
      fingerprint,
      revision,
      approvedRevision: revision,
      status: "ready",
      errorMessage: null,
    });
    rescoreAssignment(a.id);
    const staleCount = listStaleIds(a.id, revision).length;
    if (o.open && studentUploadsEnabled()) setAssignmentStatus(a, "open");
    return { revision, staleCount };
  });
}
