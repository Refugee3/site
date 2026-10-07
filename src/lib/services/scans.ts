import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { getAssignment } from "@/lib/db/repos/assignments";
import { cancelQueuedJobs } from "@/lib/db/repos/jobs";
import { deleteScanRow, findScanBySha, getScan, insertScan, updateScan } from "@/lib/db/repos/scans";
import { countSubmissions, findBySha } from "@/lib/db/repos/submissions";
import { AppError, isAppError } from "@/lib/errors";
import { keyPageCountHint } from "@/lib/grading/split";
import { newId, sha256Hex } from "@/lib/ids";
import { enqueueSplitScan } from "@/lib/jobs/queue";
import { describePapers, everyNLayout, formatPageRanges, papersFromLayout } from "@/lib/scan-layout";
import { loadKeyState, requireKey } from "@/lib/services/key-state";
import { assertKeyApproved, storeTeacherPaper } from "@/lib/services/submissions";
import { readDataFile, removeDataFile, writeFileAtomic } from "@/lib/storage/files";
import { scanPdfRel } from "@/lib/storage/paths";
import { CutTooLargeError, extractPageSets, sanitizeFilename, validatePdf, type UploadedFile } from "@/lib/storage/pdf";
import type { Assignment, Scan, ScanLayout, ScanSplitMode, ScanStatus } from "@/lib/types";

// One scan of a whole class's papers: split (by the AI, or every N pages), checked by the teacher, then
// cut into one teacher submission per paper.

const MIB = 1_048_576;
const MAX_PAGES_PER_PAPER = 100;
const CREATING_MESSAGE = "These papers are already being created.";
/** Why a scan in this status can't take the action asked for. */
const STATUS_REFUSAL: Record<ScanStatus, string> = {
  splitting: "The AI is still splitting this scan.",
  review: "This scan is waiting for you to check the split.",
  creating: CREATING_MESSAGE,
  done: "Papers were already created from this scan.",
  failed: "This scan couldn't be split.",
};

/** Stores the scan and, in automatic mode, queues the AI split; "every N pages" goes straight to review. */
export async function ingestScan(a: Assignment, f: UploadedFile, o: { mode: ScanSplitMode; pagesPerPaper: number | null }): Promise<Scan> {
  assertKeyApproved(a);
  const pagesPerPaper = o.mode === "every" ? readPagesPerPaper(o.pagesPerPaper) : null;
  const { pageCount } = await validatePdf(f.bytes, { maxPages: getConfig().maxScanPages });
  const sha = sha256Hex(f.bytes);
  if (requireKey(a.id).sourceSha256 === sha) {
    throw new AppError("is_answer_key", "This file is the answer key, not the students' papers.");
  }
  const earlier = findScanBySha(a.id, sha);
  if (earlier?.status === "failed") await deleteScan(earlier);
  else if (earlier) throw new AppError("duplicate", "You already uploaded this scan.");

  const id = newId();
  const pdfPath = scanPdfRel(a.id, id);
  await writeFileAtomic(pdfPath, f.bytes);
  try {
    return tx(() => {
      const scan = insertScan({
        id,
        assignmentId: a.id,
        status: pagesPerPaper === null ? "splitting" : "review",
        splitMode: o.mode,
        pagesPerPaper,
        pdfPath,
        originalFilename: sanitizeFilename(f.filename),
        contentSha256: sha,
        byteSize: f.bytes.byteLength,
        pageCount,
        layout: pagesPerPaper === null ? null : everyNLayout(pageCount, pagesPerPaper),
      });
      if (pagesPerPaper === null) enqueueSplitScan(id, a.id);
      return scan;
    });
  } catch (e) {
    await removeDataFile(pdfPath);
    throw e;
  }
}

function readPagesPerPaper(n: number | null): number {
  if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_PAGES_PER_PAPER) {
    const message = `Pages per student must be a whole number from 1 to ${MAX_PAGES_PER_PAPER}.`;
    throw new AppError("validation", message, { fieldErrors: { pagesPerPaper: [message] } });
  }
  return n;
}

/**
 * Replaces the split with one paper every `pagesPerPaper` pages; a running AI split is discarded (new generation).
 * The AI's proposal, when it made one, is kept, so the teacher can still go back to it on the review page.
 */
export function splitScanEvery(scan: Scan, pagesPerPaper: number): Scan {
  const n = readPagesPerPaper(pagesPerPaper);
  return tx(() => {
    const current = requireScan(scan.id, ["splitting", "review", "failed"]);
    cancelQueuedJobs("split_scan", current.id);
    const layout = everyNLayout(current.pageCount, n);
    // The readings stay: they still name the students on the review page. A scan the AI never read has no proposal
    // of its own; like one uploaded to be split every N pages, its proposal is that split.
    return updateScan(current.id, {
      splitGeneration: current.splitGeneration + 1,
      splitMode: "every",
      pagesPerPaper: n,
      layout,
      proposedLayout: current.readings.length > 0 ? current.proposedLayout : layout,
      status: "review",
      errorMessage: null,
      statusNote: null,
    });
  });
}

/** Has the AI read the whole scan again from the start. */
export function retryScanWithAi(scan: Scan): Scan {
  return tx(() => {
    const current = requireScan(scan.id, ["review", "failed"]);
    const updated = updateScan(current.id, {
      splitGeneration: current.splitGeneration + 1,
      splitMode: "auto",
      pagesPerPaper: null,
      readings: [],
      pagesRead: 0,
      layout: null,
      proposedLayout: null,
      status: "splitting",
      errorMessage: null,
      statusNote: null,
      splitStartedAt: now(),
      splitFinishedAt: null,
    });
    enqueueSplitScan(current.id, current.assignmentId);
    return updated;
  });
}

/**
 * Cuts the scan into one PDF per paper of `layout` and stores each as a teacher submission to be graded.
 * Papers whose content is already in the assignment are skipped and counted, so running it again after a
 * crash or failure creates nothing twice. Any failure puts the scan back to review (papers created stay).
 * `auto`: the server does it without the teacher (autoGradeCleanSplit); the scan then records that it was auto-graded.
 */
export async function createPapersFromScan(
  a: Assignment, scan: Scan, layout: ScanLayout, o: { auto?: boolean } = {},
): Promise<{ created: number; duplicates: number }> {
  const { maxPages } = getConfig();
  if (layout.length !== scan.pageCount) {
    throw new AppError("validation", "The split doesn't match the scan's pages. Reload the page and try again.");
  }
  const papers = papersFromLayout(layout);
  if (papers.length === 0) throw new AppError("validation", "Keep at least one page.");
  papers.forEach((pages, i) => {
    if (pages.length > maxPages) {
      throw new AppError("validation", `Paper ${i + 1} has ${pages.length} pages; the limit is ${maxPages}. Mark where the next paper starts.`);
    }
  });
  const current = tx(() => {
    const latest = getScan(scan.id);
    if (!latest) throw scanGone();
    if (latest.status !== "review") throw new AppError("invalid_state", STATUS_REFUSAL[latest.status]);
    assertKeyApproved(a);
    return updateScan(latest.id, { status: "creating", layout });
  });

  try {
    const counts = await storePapers(a, current, papers);
    updateScan(current.id, {
      status: "done", createdCount: counts.created, duplicateCount: counts.duplicates, ...(o.auto ? { autoGraded: true } : {}),
    });
    return counts;
  } catch (e) {
    updateScan(current.id, { status: "review" });
    throw e;
  }
}

async function storePapers(a: Assignment, scan: Scan, papers: number[][]): Promise<{ created: number; duplicates: number }> {
  const { maxUploadBytes, maxScanBytes } = getConfig();
  // All cuts are held until they are stored. Cut from a scan whose pages each carry their own image, they add up
  // to about the scan's size; pages sharing one large image or font would multiply it, so the total is capped too.
  const maxTotalBytes = Math.max(maxScanBytes, 2 * scan.byteSize);
  let pdfs: Uint8Array[];
  try {
    // One parse of the scan for all papers; its bytes are not kept past the cut.
    pdfs = await extractPageSets(await readDataFile(scan.pdfPath), papers, { maxBytesPerSet: maxUploadBytes, maxTotalBytes });
  } catch (e) {
    if (!(e instanceof CutTooLargeError)) throw e;
    if (e.limit === "per_set") {
      throw new AppError("too_large", `Paper ${e.index + 1} (pages ${formatPageRanges(papers[e.index])}) is ${(e.bytes / MIB).toFixed(1)} MB; `
        + `papers can be at most ${maxUploadBytes / MIB} MB. Rescan at a lower resolution.`);
    }
    throw new AppError("too_large", `The papers cut from this scan would take more than ${Math.round(maxTotalBytes / MIB)} MB: `
      + "its pages share large images or fonts, and every paper needs its own copy. Scan the paper stack instead (a scanner "
      + "gives each page its own image), or upload each student's paper on its own.");
  }
  const shas = pdfs.map((pdf) => sha256Hex(pdf));
  assertRoomFor(a.id, new Set(shas.filter((sha) => !findBySha(a.id, sha))).size);

  let created = 0;
  for (const [i, pages] of papers.entries()) {
    const stored = await storeTeacherPaper(
      a, { bytes: pdfs[i], pageCount: pages.length, contentSha256: shas[i] }, `${scan.originalFilename} (pages ${formatPageRanges(pages)})`,
    );
    if (stored) created++;
  }
  return { created, duplicates: papers.length - created };
}

/**
 * Refuses before anything is stored when the new papers would pass the assignment's limit. Exact on a re-run,
 * where papers created earlier already count; concurrent uploads are still caught per paper by storeSubmission.
 */
function assertRoomFor(assignmentId: string, fresh: number): void {
  const assignment = getAssignment(assignmentId);
  if (!assignment) throw new AppError("not_found", "This assignment no longer exists.");
  const remaining = Math.max(0, assignment.maxSubmissions - countSubmissions(assignmentId));
  if (fresh > remaining) {
    throw new AppError("submission_limit", `This assignment can take only ${remaining} more papers. Raise the limit in the assignment's Settings.`);
  }
}

/**
 * Right after the AI split a scan: when its proposal has nothing for the teacher to check (no paper with any flag of
 * describePapers: low confidence, unusual page count, no name, several names, unread pages, too many pages), grades it at
 * once, exactly as "Grade N papers" would with the AI's layout. It needs the approved key and room under the submission limit
 * like the button does; when anything is flagged or creating the papers fails, the scan stays in review for the teacher.
 * True when the papers were created.
 */
export async function autoGradeCleanSplit(scanId: string): Promise<boolean> {
  const scan = getScan(scanId);
  const assignment = scan && getAssignment(scan.assignmentId);
  if (!scan || !assignment || scan.status !== "review" || scan.splitMode !== "auto" || !scan.layout || scan.readings.length === 0) {
    return false;
  }
  const { key, items, approved } = loadKeyState(assignment.id);
  if (!approved) return false; // the teacher grades it once the key is approved
  const papers = describePapers(scan.layout, scan.readings, { keyPageCount: keyPageCountHint(key, items), maxPagesPerPaper: getConfig().maxPages });
  if (papers.length === 0 || papers.some((paper) => paper.flags.length > 0)) return false;
  try {
    await createPapersFromScan(assignment, scan, scan.layout, { auto: true });
    return true;
  } catch (e) {
    // Left in review: the teacher sees the split and the reason when they press "Grade N papers".
    const reason = isAppError(e) ? `${e.code}: ${e.message}` : e;
    console.warn(`[scans] could not grade scan ${scanId} automatically; it waits for the teacher`, reason);
    return false;
  }
}

/** Papers already created from the scan stay. Refused while papers are being created from it. */
export async function deleteScan(scan: Scan): Promise<void> {
  tx(() => {
    if (getScan(scan.id)?.status === "creating") throw new AppError("invalid_state", CREATING_MESSAGE);
    cancelQueuedJobs("split_scan", scan.id);
    deleteScanRow(scan.id);
  });
  await removeDataFile(scan.pdfPath);
}

function requireScan(id: string, allowed: ScanStatus[]): Scan {
  const scan = getScan(id);
  if (!scan) throw scanGone();
  if (!allowed.includes(scan.status)) throw new AppError("invalid_state", STATUS_REFUSAL[scan.status]);
  return scan;
}

function scanGone(): AppError {
  return new AppError("not_found", "This scan no longer exists.");
}
