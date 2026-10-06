import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { assertSameOrigin, readUploadedFiles, toErrorResponse } from "@/lib/http/request";
import { ingestKeyPdf } from "@/lib/services/keys";

/** Uploads (or replaces) the answer-key PDF and queues its extraction. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/key">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    assertSameOrigin(req);
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    const [file] = await readUploadedFiles(req, "file", 1);
    const key = await ingestKeyPdf(assignment, file);
    return Response.json({ status: key.status }, { status: 202 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
