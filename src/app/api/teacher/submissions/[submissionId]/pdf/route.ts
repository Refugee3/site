import type { NextRequest } from "next/server";
import { ownedSubmissionOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { toErrorResponse } from "@/lib/http/request";
import { pdfResponse, readDataFile } from "@/lib/storage/files";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/teacher/submissions/[submissionId]/pdf">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const { submission } = ownedSubmissionOr404((await ctx.params).submissionId, teacher);
    return pdfResponse(await readDataFile(submission.pdfPath));
  } catch (e) {
    return toErrorResponse(e);
  }
}
