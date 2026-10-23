import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { assertSameOrigin, readUploadedFiles, toErrorResponse } from "@/lib/http/request";
import { ingestKeyPdf } from "@/lib/services/keys";

/** Uploads (or replaces) the answer key (its files merged into one PDF, in order) and queues its extraction. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/key">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    assertSameOrigin(req);
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    const files = await readUploadedFiles(req, "file", getConfig().maxUploadFiles);
    const key = await ingestKeyPdf(assignment, files);
    return Response.json({ status: key.status }, { status: 202 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
