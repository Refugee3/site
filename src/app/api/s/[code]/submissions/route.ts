import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { checkCodeLookup, checkStudentUpload, countCodeLookupMiss, countStudentSubmission } from "@/lib/http/rate-limit";
import { assertSameOrigin, clientIp, readUploadedFiles, toErrorResponse } from "@/lib/http/request";
import { normalizeShareCode } from "@/lib/ids";
import { ingestStudentUpload } from "@/lib/services/submissions";
import { getStudentUploadView } from "@/lib/services/views";

// The upload form's per-upload id (Idempotency-Key); anything else is ignored, which only disables the replay.
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * A student's upload through the share link. Every cheap check runs before the body is read, and
 * requests that cannot cost anything (unknown codes, junk bodies) never count against the limits that
 * every class shares.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/s/[code]/submissions">): Promise<Response> {
  try {
    const code = normalizeShareCode((await ctx.params).code);
    if (!code) throw new AppError("not_found", "This assignment link is not valid.");
    assertSameOrigin(req, { allowMissing: true }); // a missing Origin (scripts, curl) is allowed but rate limited
    const ip = clientIp(req.headers);
    checkCodeLookup(ip);
    const view = getStudentUploadView(code);
    if (!view) {
      countCodeLookupMiss(ip);
      throw new AppError("not_found", "This assignment link is not valid.");
    }
    if (!view.accepting) throw new AppError("closed", "This assignment is not accepting submissions right now.");
    checkStudentUpload(ip, code);

    const files = await readUploadedFiles(req, "files", getConfig().maxUploadFiles);
    const uploadId = req.headers.get("idempotency-key");
    const { receiptUrl, duplicate } = await ingestStudentUpload(code, files, uploadId && UPLOAD_ID_RE.test(uploadId) ? uploadId : null);
    // Re-sending an upload (same id, same bytes; e.g. after a dropped connection) returns its receipt.
    if (duplicate) return Response.json({ receiptUrl, duplicate: true });
    countStudentSubmission(code);
    return Response.json({ receiptUrl }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
