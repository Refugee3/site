import type { NextRequest } from "next/server";
import { ownedScanOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { toErrorResponse } from "@/lib/http/request";
import { pdfResponse, readDataFile } from "@/lib/storage/files";

/**
 * The scan, for its owner's review page. Unlike other PDFs it may be cached by the browser (never by shared
 * caches): the page reloads the frame on every page jump, a scan can be 100 MB, and it never changes under its id.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/teacher/scans/[scanId]/pdf">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const { scan } = ownedScanOr404((await ctx.params).scanId, teacher);
    const response = pdfResponse(await readDataFile(scan.pdfPath));
    response.headers.set("Cache-Control", "private, max-age=3600");
    return response;
  } catch (e) {
    return toErrorResponse(e);
  }
}
