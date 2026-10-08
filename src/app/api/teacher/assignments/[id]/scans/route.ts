import type { NextRequest } from "next/server";
import * as z from "zod";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, readUploadedFiles, toErrorResponse } from "@/lib/http/request";
import { parseInput } from "@/lib/http/validation";
import { loadKeyState } from "@/lib/services/key-state";
import { ingestScan } from "@/lib/services/scans";
import type { ScanSplitMode } from "@/lib/types";

const SplitModeSchema = z.enum(["auto", "every"], "Choose how the scan should be split.");
const PAGES_MESSAGE = "Enter the pages per student as a whole number from 1 to 100.";
const PagesPerPaperSchema = z.coerce.number(PAGES_MESSAGE).int(PAGES_MESSAGE).min(1, PAGES_MESSAGE).max(100, PAGES_MESSAGE);

/**
 * One scan of a whole class's papers (`?mode=auto`, or `?mode=every&pagesPerPaper=N`), uploaded by the
 * teacher. Answers 201 with where to check the split. A clean AI split is graded automatically; any other split waits
 * for the teacher's check.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/scans">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    assertSameOrigin(req);
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    // Checked before reading the body, so a refused upload is never read; ingestScan checks again.
    if (!loadKeyState(assignment.id).approved) {
      throw new AppError("key_not_ready", "Approve the answer key before uploading papers.");
    }
    const options = splitOptions(req.nextUrl.searchParams);
    const files = await readUploadedFiles(req, "file", getConfig().maxUploadFiles, { maxBytes: getConfig().maxScanBytes });
    const scan = await ingestScan(assignment, files, options);
    return Response.json(
      { scanId: scan.id, reviewUrl: `/teacher/assignments/${assignment.id}/scans/${scan.id}` },
      { status: 201 },
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}

function splitOptions(params: URLSearchParams): { mode: ScanSplitMode; pagesPerPaper: number | null } {
  const mode = parseInput(SplitModeSchema, params.get("mode"));
  return { mode, pagesPerPaper: mode === "every" ? parseInput(PagesPerPaperSchema, params.get("pagesPerPaper")) : null };
}
