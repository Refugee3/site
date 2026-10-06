import type { NextRequest } from "next/server";
import { getSubmissionByReceipt } from "@/lib/db/repos/submissions";
import { AppError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http/request";
import { isToken } from "@/lib/ids";
import { pdfResponse, readDataFile } from "@/lib/storage/files";

/** The student's own PDF; the receipt token is the only credential. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/r/[token]/pdf">): Promise<Response> {
  try {
    const { token } = await ctx.params;
    const submission = isToken(token) ? getSubmissionByReceipt(token) : null;
    if (!submission) throw new AppError("not_found", "This receipt link is not valid.");
    return pdfResponse(await readDataFile(submission.pdfPath));
  } catch (e) {
    return toErrorResponse(e);
  }
}
