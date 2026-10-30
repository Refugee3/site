import { NextResponse, type NextRequest } from "next/server";
import { RETURN_TO_HEADER } from "@/lib/auth/next-path";

/**
 * Not an auth check: the DAL stays the auth boundary. This only tells the DAL which teacher page was
 * asked for (server actions post to the page they run on), so that a missing or expired session can send
 * the teacher back there after logging in (`requireTeacher`). Uploads never pass through here: they go to
 * /api routes, and proxy buffers request bodies.
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(RETURN_TO_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/teacher/:path*"],
};
