import type { NextRequest } from "next/server";
import { ownedAssignmentOr404, requireRouteTeacher, sessionStillValid } from "@/lib/auth/dal";
import { getAssignmentForTeacher } from "@/lib/db/repos/assignments";
import { logUnexpectedError } from "@/lib/http/log";
import { toErrorResponse } from "@/lib/http/request";
import { liveEventStream, SSE_HEADERS } from "@/lib/http/sse";
import { assignmentLiveSignature } from "@/lib/live/snapshot";
import { assignmentLiveStamp, loadAssignmentLive } from "@/lib/services/live";

/**
 * The assignment's workspace, live (Server-Sent Events): a "snapshot" event (AssignmentLiveSnapshot) at once and whenever the
 * key, its questions, the papers, the grading progress or the scans change. The server polls its own database about once a
 * second and sends nothing when nothing changed; no AI calls. Owner only, like every teacher route.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/teacher/assignments/[id]/live">): Promise<Response> {
  let stream: ReadableStream<Uint8Array>;
  try {
    const teacher = await requireRouteTeacher();
    const { id } = ownedAssignmentOr404((await ctx.params).id, teacher);
    stream = liveEventStream({
      signal: req.signal,
      probe: () => assignmentLiveStamp(id),
      build: () => {
        const assignment = getAssignmentForTeacher(id, teacher.id);
        return assignment ? loadAssignmentLive(assignment) : null;
      },
      signature: assignmentLiveSignature,
      stillAllowed: await sessionStillValid(teacher),
      onError: (e) => logUnexpectedError("Live assignment stream failed", e),
    });
  } catch (e) {
    return toErrorResponse(e);
  }
  return new Response(stream, { headers: SSE_HEADERS });
}
