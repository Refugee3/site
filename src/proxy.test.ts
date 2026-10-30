import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { RETURN_TO_HEADER } from "@/lib/auth/next-path";
import { config, proxy } from "@/proxy";

describe("proxy", () => {
  it("passes the requested teacher page (path and query) on as a request header, and nothing else", () => {
    const res = proxy(new NextRequest("http://localhost:3000/teacher/assignments/abc/board?filter=review", {
      headers: { [RETURN_TO_HEADER]: "/teacher/forged", cookie: "pag_session=x" },
    }));
    expect(res.status).toBe(200);
    // NextResponse.next({ request: { headers } }) hands overridden request headers to Next this way.
    expect(res.headers.get(`x-middleware-request-${RETURN_TO_HEADER}`)).toBe("/teacher/assignments/abc/board?filter=review");
    expect(res.headers.get(`x-middleware-request-cookie`)).toBe("pag_session=x");
    expect(res.headers.get("location")).toBeNull();
  });

  it("runs only for teacher pages, never for uploads under /api", () => {
    expect(config.matcher).toEqual(["/teacher/:path*"]);
  });
});
