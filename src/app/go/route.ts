import type { NextRequest } from "next/server";
import { isAppError } from "@/lib/errors";
import { logUnexpectedError } from "@/lib/http/log";
import { checkCodeLookup, countCodeLookupMiss } from "@/lib/http/rate-limit";
import { clientIp } from "@/lib/http/request";
import { normalizeShareCode } from "@/lib/ids";
import { getStudentUploadView } from "@/lib/services/views";

/**
 * The start page's code box (a plain GET form): "k7m4-qx" → /s/K7M4QX. It always answers with a redirect,
 * never JSON: unknown or malformed codes, too many misses and server errors go back to the box with an
 * error the start page explains.
 */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const code = normalizeShareCode(req.nextUrl.searchParams.get("code") ?? "");
    if (code === null) return seeOther("/?error=code"); // no lookup, so nothing to learn and nothing to count
    const ip = clientIp(req.headers);
    checkCodeLookup(ip);
    if (getStudentUploadView(code) === null) {
      countCodeLookupMiss(ip);
      return seeOther("/?error=code");
    }
    return seeOther(`/s/${code}`);
  } catch (e) {
    if (isAppError(e) && e.code === "rate_limited") return seeOther("/?error=rate");
    logUnexpectedError("Code lookup failed", e);
    return seeOther("/?error=server");
  }
}

/** A relative Location is resolved by the browser against the URL it used, so proxies need no special care. */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
