import type { NextRequest } from "next/server";
import { requireRouteTeacher, sessionStillValid } from "@/lib/auth/dal";
import { logUnexpectedError } from "@/lib/http/log";
import { toErrorResponse } from "@/lib/http/request";
import { liveEventStream, SSE_HEADERS } from "@/lib/http/sse";
import { dashboardLiveSignature } from "@/lib/live/snapshot";
import { dashboardLiveStamp, loadDashboardLive } from "@/lib/services/live";

/**
 * The dashboard, live (Server-Sent Events): a "snapshot" event (DashboardLiveSnapshot) at once and whenever one of the teacher's
 * assignment cards would change: a key read, papers graded, a scan split. Polls the database about once a second; no AI calls.
 */
export async function GET(req: NextRequest): Promise<Response> {
  let stream: ReadableStream<Uint8Array>;
  try {
    const teacher = await requireRouteTeacher();
    stream = liveEventStream({
      signal: req.signal,
      probe: () => dashboardLiveStamp(teacher.id),
      build: () => loadDashboardLive(teacher),
      signature: dashboardLiveSignature,
      stillAllowed: await sessionStillValid(teacher),
      onError: (e) => logUnexpectedError("Live dashboard stream failed", e),
    });
  } catch (e) {
    return toErrorResponse(e);
  }
  return new Response(stream, { headers: SSE_HEADERS });
}
