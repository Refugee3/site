import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { getPublicOrigin, toErrorResponse } from "@/lib/http/request";
import { buildGradesCsv } from "@/lib/services/views";

/** The grades as CSV (BOM, CRLF), current attempts in board order. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/export">): Promise<Response> {
  try {
    const teacher = await requireRouteTeacher();
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    const { filename, csv } = buildGradesCsv(assignment, getPublicOrigin(req.headers));
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        // The slug is [a-z0-9-] only, so it needs no quoting beyond the quotes themselves.
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
