"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import * as z from "zod";
import { requireOwnedScan } from "@/lib/auth/dal";
import { attempt, attemptWithData } from "@/lib/http/action-result";
import { parseInput } from "@/lib/http/validation";
import { createPapersFromScan, deleteScan, retryScanWithAi, splitScanEvery } from "@/lib/services/scans";
import type { ActionResult, ScanLayout } from "@/lib/types";

// Shape only: createPapersFromScan checks the layout against the scan (one entry per page) and the limits.
const LayoutSchema: z.ZodType<ScanLayout> = z
  .array(z.object({ startsPaper: z.boolean(), dropped: z.boolean() }), "Send the split as a list of pages.")
  .max(500, "A scan can have at most 500 pages.");

const PAGES_MESSAGE = "Enter the pages per student as a whole number from 1 to 100.";
const PagesPerPaperSchema = z.number(PAGES_MESSAGE).int(PAGES_MESSAGE).min(1, PAGES_MESSAGE).max(100, PAGES_MESSAGE);

/** Cuts one paper per group of pages and queues each for grading; can take a few seconds for a large scan. */
export async function createPapersFromScanAction(
  scanId: string,
  layout: ScanLayout,
): Promise<ActionResult<{ created: number; duplicates: number }>> {
  const { assignment, scan } = await requireOwnedScan(scanId);
  const result = await attemptWithData(() => createPapersFromScan(assignment, scan, parseInput(LayoutSchema, layout)));
  if (result.ok) refresh();
  return result;
}

export async function splitScanEveryAction(scanId: string, pagesPerPaper: number): Promise<ActionResult> {
  const { scan } = await requireOwnedScan(scanId);
  const result = await attempt(() => splitScanEvery(scan, parseInput(PagesPerPaperSchema, pagesPerPaper)));
  if (result.ok) refresh();
  return result;
}

const RetryModeSchema = z.enum(["auto", "one_pass"], "Choose how the AI should read the scan.").optional();

/** `mode`: split the scan first (`auto`) or grade it in one pass; omitted, the scan keeps its way (see retryScanWithAi). */
export async function retryScanWithAiAction(scanId: string, mode?: "auto" | "one_pass"): Promise<ActionResult> {
  const { scan } = await requireOwnedScan(scanId);
  const result = await attempt(() => retryScanWithAi(scan, { mode: parseInput(RetryModeSchema, mode) }));
  if (result.ok) refresh();
  return result;
}

/** Goes back to the assignment's upload tab afterwards; papers already created from the scan stay. */
export async function deleteScanAction(scanId: string): Promise<ActionResult> {
  const { assignment, scan } = await requireOwnedScan(scanId);
  const result = await attempt(() => deleteScan(scan));
  if (!result.ok) return result;
  refresh();
  redirect(`/teacher/assignments/${assignment.id}/upload`);
}
