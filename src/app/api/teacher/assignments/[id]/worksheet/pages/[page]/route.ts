import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { getWorksheet } from "@/lib/db/repos/worksheets";
import { AppError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http/request";
import { grayToPng, openPdf } from "@/lib/omr/pdf-raster";
import { readDataFile } from "@/lib/storage/files";
import { pngResponse } from "@/lib/storage/images";

/** Pixels across a blank page in the answer-spot editor. */
const EDITOR_WIDTH = 1100;

/** One page of the blank worksheet as PNG, for the answer-spot editor (owner only; `?v=` is the worksheet's hash). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/worksheet/pages/[page]">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const params = await ctx.params;
    const assignment = ownedAssignmentOr404(params.id, teacher);
    const worksheet = getWorksheet(assignment.id);
    const page = Number(params.page);
    if (!worksheet || !Number.isInteger(page) || page < 1 || page > worksheet.pageCount) {
      throw new AppError("not_found", "That page of the blank worksheet doesn't exist.");
    }
    const doc = await openPdf(await readDataFile(worksheet.pdfPath));
    try {
      return pngResponse(await grayToPng(await doc.renderGray(page, { widthPx: EDITOR_WIDTH })));
    } finally {
      await doc.close();
    }
  } catch (e) {
    return toErrorResponse(e);
  }
}
