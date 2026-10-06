import type { NextRequest } from "next/server";
import { checkCodeLookup } from "@/lib/http/rate-limit";
import { clientIp, toErrorResponse } from "@/lib/http/request";
import { normalizeShareCode } from "@/lib/ids";
import { getStudentUploadView } from "@/lib/services/views";

/** The start page's code box: "k7m4-qx" → /s/K7M4QX. Unknown or malformed codes go back to the box with an error. */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    checkCodeLookup(clientIp(req.headers));
    const code = normalizeShareCode(req.nextUrl.searchParams.get("code") ?? "");
    const known = code !== null && getStudentUploadView(code) !== null;
    return seeOther(known ? `/s/${code}` : "/?error=code");
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** A relative Location is resolved by the browser against the URL it used, so proxies need no special care. */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
