import type { NextRequest } from "next/server";
import { ownedSubmissionOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { toErrorResponse } from "@/lib/http/request";
import { pdfResponse, readDataFile } from "@/lib/storage/files";

/** The paper as uploaded; `?copy=hidden`: the copy with its names covered that the grading AI read. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/teacher/submissions/[submissionId]/pdf">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const { submission } = ownedSubmissionOr404((await ctx.params).submissionId, teacher);
    const hidden = req.nextUrl.searchParams.get("copy") === "hidden" && submission.namesHiddenPdfPath;
    return pdfResponse(await readDataFile(hidden ? submission.namesHiddenPdfPath! : submission.pdfPath));
  } catch (e) {
    return toErrorResponse(e);
  }
}
