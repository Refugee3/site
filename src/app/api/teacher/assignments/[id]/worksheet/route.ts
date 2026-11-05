import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { assertSameOrigin, readUploadedFiles, toErrorResponse } from "@/lib/http/request";
import { ingestBlankWorksheet } from "@/lib/services/worksheets";

/**
 * Uploads (or replaces) the blank worksheet for mark detection: its files merged into one PDF, its answer spots found from
 * the text layer at once, or by the AI in the background for a scan (status "detecting").
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/worksheet">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    assertSameOrigin(req);
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    const files = await readUploadedFiles(req, "file", getConfig().maxUploadFiles);
    const worksheet = await ingestBlankWorksheet(assignment, files);
    return Response.json({ status: worksheet.status, spots: worksheet.spots.length }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
