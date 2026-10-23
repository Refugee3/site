import type { NextRequest } from "next/server";
import { ownedScanOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { toErrorResponse } from "@/lib/http/request";
import { pdfResponse, readDataFile } from "@/lib/storage/files";

/**
 * The scan, for its owner's review page. Unlike other PDFs it may be kept by the browser (never by shared caches),
 * but it is revalidated on every use: the page remounts the frame on every page jump and a scan can be 100 MB, so
 * each remount costs one small authenticated request that answers 304 when the browser already has these bytes
 * (a scan never changes under its id, so its content hash is a stable ETag). The sign-in and ownership checks run
 * before the 304, so after logout or deletion a cached copy is never served again.
 * Caveat: `no-cache` still lets the browser keep the bytes on disk until a failed revalidation replaces them or
 * they are evicted; only `no-store` (a full re-download per page jump) would avoid that.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/teacher/scans/[scanId]/pdf">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const { scan } = ownedScanOr404((await ctx.params).scanId, teacher);
    const etag = `"${scan.contentSha256}"`;
    const cacheHeaders = { ETag: etag, "Cache-Control": "private, no-cache" };
    if (matchesEtag(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: cacheHeaders });
    const response = pdfResponse(await readDataFile(scan.pdfPath));
    for (const [name, value] of Object.entries(cacheHeaders)) response.headers.set(name, value);
    return response;
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** If-None-Match uses weak comparison (RFC 9110 §13.1.2): any listed tag, `W/` or not, or `*`. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((entry) => {
    const tag = entry.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}
