import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { getKey } from "@/lib/db/repos/keys";
import { AppError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http/request";
import { pdfResponse, readDataFile } from "@/lib/storage/files";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/key/pdf">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    const pdfPath = getKey(assignment.id)?.sourcePdfPath;
    if (!pdfPath) throw new AppError("not_found", "No answer-key PDF has been uploaded.");
    return pdfResponse(await readDataFile(pdfPath));
  } catch (e) {
    return toErrorResponse(e);
  }
}
