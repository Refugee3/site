import { getGrader } from "@/lib/ai";
import { classifySdkError } from "@/lib/ai/errors";
import type { AnswerSpots } from "@/lib/ai/grader";
import { itemRefs } from "@/lib/ai/prompts";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { tx } from "@/lib/db/connection";
import { getKey, listKeyItems } from "@/lib/db/repos/keys";
import {
  type BlankWorksheet, deleteWorksheet, getWorksheet, putWorksheet, updateWorksheet,
} from "@/lib/db/repos/worksheets";
import { AppError } from "@/lib/errors";
import { keyPageCountHint } from "@/lib/grading/split";
import { newId } from "@/lib/ids";
import { recordUsage } from "@/lib/jobs/handler-shared";
import { answerSpots } from "@/lib/omr/detect";
import { isUsable, planSpots } from "@/lib/omr/map-key";
import { grayToPng, openPdf } from "@/lib/omr/pdf-raster";
import { proposalToSpots } from "@/lib/omr/propose";
import { clampBox, detectSpotsFromText, type KeyItemOutline, type TextPage } from "@/lib/omr/text-zones";
import { type QuestionSpots, type GrayImage } from "@/lib/omr/types";
import { readDataFile, removeDataFile, writeFileAtomic } from "@/lib/storage/files";
import { blankWorksheetPdfRel } from "@/lib/storage/paths";
import { buildSubmissionPdf, uploadName, type UploadedFile } from "@/lib/storage/pdf";
import type { Assignment, KeyItem } from "@/lib/types";

// The blank worksheet of an assignment and its answer spots (mark detection, src/lib/omr). A digital blank's spots come from
// its text layer at once; a scanned blank's are proposed by the AI in the background (status "detecting"), once per upload;
// without an engine the teacher draws them. Papers are read from the spots only after the teacher has saved them.

export const NO_ENGINE_NOTE = "This blank is a scan, and no AI engine is set up to find its answer spots: draw them yourself.";
const NOTHING_FOUND = "No questions were found on the blank. Draw the answer spots yourself, or upload the worksheet as a PDF "
  + "exported from Word or Google Docs.";
/** A blank page is shown to the AI in an image of about this many pixels, both sides multiples of 28 (Qwen2.5-VL's patches). */
const PROPOSAL_PIXELS = 1_000_000;

/** Stores the uploaded blank worksheet (any accepted format, merged into one PDF) and finds its answer spots. */
export async function ingestBlankWorksheet(a: Assignment, upload: UploadedFile | UploadedFile[]): Promise<BlankWorksheet> {
  const files = [upload].flat();
  const { bytes, pageCount, contentSha256 } = await buildSubmissionPdf(files, { maxPages: getConfig().maxPages });
  const read = await readText(bytes);
  const spots = read.hasText ? detectSpotsFromText(read.pages, outline(listKeyItems(a.id))) : [];
  const propose = spots.length === 0 && canPropose();
  const pdfPath = blankWorksheetPdfRel(a.id, newId());
  await writeFileAtomic(pdfPath, bytes);
  let stored: ReturnType<typeof putWorksheet>;
  try {
    stored = tx(() => putWorksheet({
      assignmentId: a.id, pdfPath, originalFilename: uploadName(files), contentSha256, byteSize: bytes.byteLength, pageCount,
      pageSizes: read.pageSizes, hasText: read.hasText,
      status: propose ? "detecting" : "ready",
      spotsSource: spots.length > 0 ? "text" : propose ? null : "manual",
      spots,
      note: spots.length > 0 || propose ? null : read.hasText ? NOTHING_FOUND : NO_ENGINE_NOTE,
      confirmedAt: null,
    }));
  } catch (e) {
    await removeDataFile(pdfPath);
    throw e;
  }
  if (stored.replacedPdfPath) await removeDataFile(stored.replacedPdfPath);
  if (propose) startProposal(a.id, contentSha256);
  return stored.worksheet;
}

/** Finds the answer spots again: from the text layer, or (`ai`, or a scan) by the AI. Unconfirms the spots. */
export async function findSpotsAgain(a: Assignment, o: { ai: boolean }): Promise<BlankWorksheet> {
  const ws = requireWorksheet(a.id);
  if (ws.status === "detecting") throw new AppError("invalid_state", "The AI is still looking for the answer spots.");
  if (!o.ai && ws.hasText) {
    const read = await readText(await readDataFile(ws.pdfPath));
    const spots = detectSpotsFromText(read.pages, outline(listKeyItems(a.id)));
    return updated(updateWorksheet(a.id, ws.contentSha256, {
      spots, spotsSource: spots.length > 0 ? "text" : "manual", note: spots.length > 0 ? null : NOTHING_FOUND, confirmedAt: null,
    }));
  }
  if (!canPropose()) {
    return updated(updateWorksheet(a.id, ws.contentSha256, { note: NO_ENGINE_NOTE }));
  }
  const detecting = updated(updateWorksheet(a.id, ws.contentSha256, { status: "detecting", note: null, confirmedAt: null }));
  startProposal(a.id, ws.contentSha256);
  return detecting;
}

/** The teacher's answer spots (checked, moved, drawn): saved and confirmed, so papers are read from them. */
export function saveSpots(a: Assignment, spots: QuestionSpots[]): BlankWorksheet {
  const ws = requireWorksheet(a.id);
  if (ws.status === "detecting") throw new AppError("invalid_state", "Wait until the AI has found the answer spots.");
  const clean = spots.slice(0, 300).map((s, i) => sanitizeSpot(s, i, ws.pageCount));
  return updated(updateWorksheet(a.id, ws.contentSha256, {
    spots: clean, spotsSource: ws.spotsSource ?? "manual", confirmedAt: now(), note: null,
  }));
}

export async function removeBlankWorksheet(a: Assignment): Promise<void> {
  const removed = tx(() => deleteWorksheet(a.id));
  if (removed) await removeDataFile(removed.pdfPath);
}

/**
 * Mark detection for grading the assignment's papers now, or null: no blank, its spots not saved yet, or none linked to a
 * key item.
 */
export function answerSpotsFor(assignmentId: string, items: KeyItem[]): AnswerSpots | null {
  const ws = getWorksheet(assignmentId);
  if (!ws || ws.status !== "ready" || ws.confirmedAt === null) return null;
  const refs = itemRefs(items.length);
  const plan = [...planSpots(ws.spots, items).entries()].sort((x, y) => x[0] - y[0]).map(([index, spot]) => ({ ref: refs[index], spot }));
  if (plan.length === 0) return null;
  return answerSpots({ blankPdf: () => readDataFile(ws.pdfPath), sha: ws.contentSha256, plan });
}

function requireWorksheet(assignmentId: string): BlankWorksheet {
  const ws = getWorksheet(assignmentId);
  if (!ws) throw new AppError("not_found", "There is no blank worksheet. Upload one first.");
  return ws;
}

function updated(ws: BlankWorksheet | null): BlankWorksheet {
  if (!ws) throw new AppError("conflict", "The blank worksheet was replaced meanwhile. Reload the page.");
  return ws;
}

function outline(items: KeyItem[]): KeyItemOutline[] {
  return items.map((item) => ({ label: item.label, answerType: item.answerType }));
}

function canPropose(): boolean {
  try {
    return getGrader()?.proposeSpots !== undefined;
  } catch {
    return false;
  }
}

/** Each page's size and text; `hasText`: a digital PDF (a scan has no words to read). */
async function readText(bytes: Uint8Array): Promise<{ pages: TextPage[]; pageSizes: BlankWorksheet["pageSizes"]; hasText: boolean }> {
  const doc = await openPdf(bytes, { fonts: true });
  try {
    const pages: TextPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const size = await doc.pageSize(n);
      pages.push({ tokens: await doc.textTokens(n), widthPt: size.width, heightPt: size.height });
    }
    const words = pages.reduce((sum, p) => sum + p.tokens.length, 0);
    return { pages, pageSizes: pages.map((p) => ({ width: p.widthPt, height: p.heightPt })), hasText: words >= 5 };
  } finally {
    await doc.close();
  }
}

/** Keeps a saved spot within the page and the limits; ids are reassigned in order. */
function sanitizeSpot(s: QuestionSpots, i: number, pageCount: number): QuestionSpots {
  const label = s.label.trim().slice(0, 40) || String(i + 1);
  return {
    id: `s${i + 1}`,
    label,
    itemLabel: s.itemLabel === null ? null : s.itemLabel.trim().slice(0, 40) || null,
    kind: s.kind,
    multi: s.kind === "choice" && s.multi,
    enabled: s.enabled,
    page: Math.min(Math.max(1, Math.round(s.page)), pageCount),
    options: s.kind === "choice"
      ? s.options.slice(0, 12).map((o) => ({ value: o.value.trim().slice(0, 40) || "?", box: clampBox(o.box) })).filter((o) => o.box.w > 0 && o.box.h > 0)
      : [],
    boxes: s.kind === "choice" ? [] : s.boxes.slice(0, 8).map(clampBox).filter((b) => b.w > 0 && b.h > 0),
  };
}

// ---------------------------------------------------------------------------------------------
// The AI's proposal for a scanned blank (in the background; the page shows "Finding the answer spots…" until it is done)

const SLOT = Symbol.for("pag.spot-proposals");
const running = ((globalThis as unknown as Record<symbol, Set<string> | undefined>)[SLOT] ??= new Set<string>());

function startProposal(assignmentId: string, sha: string): void {
  const key = `${assignmentId}:${sha}`;
  if (running.has(key)) return;
  running.add(key);
  void proposeSpots(assignmentId, sha).finally(() => running.delete(key));
}

async function proposeSpots(assignmentId: string, sha: string): Promise<void> {
  try {
    const grader = getGrader();
    if (!grader?.proposeSpots) {
      updateWorksheet(assignmentId, sha, { status: "ready", spotsSource: "manual", note: NO_ENGINE_NOTE });
      return;
    }
    const ws = getWorksheet(assignmentId);
    if (!ws || ws.contentSha256 !== sha) return;
    const items = listKeyItems(assignmentId);
    const doc = await openPdf(await readDataFile(ws.pdfPath));
    const spots: QuestionSpots[] = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const size = await doc.pageSize(n);
        const width = Math.max(28, Math.floor(Math.sqrt(PROPOSAL_PIXELS / (size.height / size.width)) / 28) * 28);
        const page = fitHeight(await doc.renderGray(n, { widthPx: width }), 28);
        const result = await grader.proposeSpots({
          page: { png: await grayToPng(page), width: page.width, height: page.height }, pageNumber: n, itemLabels: items.map((i) => i.label),
        }, { signal: AbortSignal.timeout(getConfig().jobTimeoutMs) });
        recordUsage(assignmentId, result.meta.servedModel, result.meta.usage, result.meta.agent);
        spots.push(...proposalToSpots(result.output, {
          page: n, width: page.width, height: page.height, items: outline(items), firstId: spots.length + 1,
        }).filter(isUsable));
      }
    } finally {
      await doc.close();
    }
    updateWorksheet(assignmentId, sha, {
      status: "ready", spotsSource: "ai", spots, confirmedAt: null,
      note: spots.length > 0 ? null : "The AI found no answer spots on this blank. Draw them yourself.",
    });
  } catch (e) {
    const err = classifySdkError(e);
    console.error(`[worksheets] couldn't find the answer spots of assignment ${assignmentId}`, e);
    try {
      updateWorksheet(assignmentId, sha, {
        status: "ready", spotsSource: "manual", spots: [], confirmedAt: null,
        note: `The AI couldn't find the answer spots (${err.message}). Draw them yourself, or try again.`,
      });
    } catch (inner) {
      console.error("[worksheets] couldn't record that", inner);
    }
  }
}

/** Crops or pads (white) the image's height to a multiple of `m`. */
function fitHeight(img: GrayImage, m: number): GrayImage {
  const height = Math.max(m, Math.round(img.height / m) * m);
  if (height === img.height) return img;
  const data = new Uint8Array(img.width * height).fill(255);
  data.set(img.data.subarray(0, Math.min(img.data.length, data.length)));
  return { width: img.width, height, data };
}

// ---------------------------------------------------------------------------------------------
// The Answer key page's "Blank worksheet" card

export interface WorksheetView {
  worksheet: {
    status: BlankWorksheet["status"];
    filename: string;
    pageCount: number;
    pageSizes: BlankWorksheet["pageSizes"];
    hasText: boolean;
    spotsSource: BlankWorksheet["spotsSource"];
    spots: QuestionSpots[];
    note: string | null;
    confirmedAt: number | null;
    /** One PNG per page for the editor, versioned by the worksheet's hash. */
    pageUrls: string[];
    /** Key items without usable spots: the AI reads those as before. */
    unlinkedItems: string[];
  } | null;
  /** The key's items, for linking spots to them. */
  items: Array<{ label: string; answerType: KeyItem["answerType"]; prompt: string }>;
  /** Engines that can find a scanned blank's spots (any AI engine; none without a key). */
  canAskAi: boolean;
  /** How many pages the answer key suggests a paper has, when it tells (a blank with another count is worth a warning). */
  keyPageCount: number | null;
}

export function getWorksheetView(a: Assignment): WorksheetView {
  const items = listKeyItems(a.id);
  const ws = getWorksheet(a.id);
  const planned = ws ? planSpots(ws.spots, items) : new Map();
  return {
    worksheet: ws && {
      status: ws.status,
      filename: ws.originalFilename,
      pageCount: ws.pageCount,
      pageSizes: ws.pageSizes,
      hasText: ws.hasText,
      spotsSource: ws.spotsSource,
      spots: ws.spots,
      note: ws.note,
      confirmedAt: ws.confirmedAt,
      pageUrls: Array.from({ length: ws.pageCount }, (_, i) => `/api/teacher/assignments/${a.id}/worksheet/pages/${i + 1}?v=${ws.contentSha256.slice(0, 16)}`),
      unlinkedItems: items.filter((_, i) => !planned.has(i)).map((item) => item.label),
    },
    items: items.map((item) => ({ label: item.label, answerType: item.answerType, prompt: item.prompt })),
    canAskAi: canPropose(),
    keyPageCount: (() => {
      const key = getKey(a.id);
      return key ? keyPageCountHint(key, items) : null;
    })(),
  };
}
