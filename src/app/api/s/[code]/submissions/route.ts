import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { checkStudentUpload } from "@/lib/http/rate-limit";
import { assertSameOrigin, clientIp, readUploadedFiles, toErrorResponse } from "@/lib/http/request";
import { normalizeShareCode } from "@/lib/ids";
import { ingestStudentUpload } from "@/lib/services/submissions";
import { getStudentUploadView } from "@/lib/services/views";

/** A student's upload through the share link. Every cheap check runs before the body is read (§2.2). */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/s/[code]/submissions">): Promise<Response> {
  try {
    const code = normalizeShareCode((await ctx.params).code);
    if (!code) throw new AppError("not_found", "This assignment link is not valid.");
    assertSameOrigin(req, { allowMissing: true }); // a missing Origin (scripts, curl) is allowed but rate limited
    checkStudentUpload(clientIp(req.headers), code);
    const view = getStudentUploadView(code);
    if (!view) throw new AppError("not_found", "This assignment link is not valid.");
    if (!view.accepting) throw new AppError("closed", "This assignment is not accepting submissions right now.");

    const files = await readUploadedFiles(req, "files", getConfig().maxUploadFiles);
    const { receiptUrl, duplicate } = await ingestStudentUpload(code, files);
    // Re-sending exactly an earlier upload (e.g. after a dropped connection) returns that receipt.
    return duplicate ? Response.json({ receiptUrl, duplicate: true }) : Response.json({ receiptUrl }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
