import type { NextRequest } from "next/server";
import { ownedSubmissionOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { listItems } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http/request";
import { renderSpotCrop } from "@/lib/omr/crop-image";
import { readDataFile } from "@/lib/storage/files";
import { pngResponse } from "@/lib/storage/images";

/**
 * The crop of one item's answer spot on a paper, as PNG, with the option read as marked outlined (owner only). Rendered on
 * demand from the stored paper, the spot and the blank → paper map stored with the item's judgment; nothing else is kept.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/teacher/submissions/[submissionId]/spots/[itemId]">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const params = await ctx.params;
    const { submission } = ownedSubmissionOr404(params.submissionId, teacher);
    const spot = listItems(submission.id).find((row) => row.itemId === params.itemId)?.judgment?.spot;
    if (!spot) throw new AppError("not_found", "This item wasn't read from an answer spot.");
    return pngResponse(await renderSpotCrop(await readDataFile(submission.pdfPath), spot));
  } catch (e) {
    return toErrorResponse(e);
  }
}
