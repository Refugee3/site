import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, getPublicOrigin, readUploadedFiles, toErrorResponse } from "@/lib/http/request";
import { loadKeyState } from "@/lib/services/key-state";
import { ingestTeacherUpload } from "@/lib/services/submissions";

/** One student's paper (its files merged in order) uploaded by the teacher; any assignment status, but the key must be approved. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/submissions">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    assertSameOrigin(req);
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    // Checked before reading the body, so a refused upload is never read; ingestTeacherUpload checks again.
    if (!loadKeyState(assignment.id).approved) {
      throw new AppError("key_not_ready", "Approve the answer key before uploading papers.");
    }
    const files = await readUploadedFiles(req, "file", getConfig().maxUploadFiles);
    const result = await ingestTeacherUpload(assignment, files, getPublicOrigin(req.headers));
    return Response.json(result, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
