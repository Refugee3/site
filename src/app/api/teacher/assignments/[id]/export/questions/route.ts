import { connection, type NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher } from "@/lib/auth/dal";
import { toErrorResponse } from "@/lib/http/request";
import { buildQuestionStatsCsv } from "@/lib/services/views";

/** How the class did on each question as CSV (BOM, CRLF), one row per key item in key order. */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/teacher/assignments/[id]/export/questions">,
): Promise<Response> {
  try {
    await connection();
    const teacher = await requireRouteTeacher();
    const assignment = ownedAssignmentOr404((await ctx.params).id, teacher);
    const { filename, csv } = buildQuestionStatsCsv(assignment);
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
