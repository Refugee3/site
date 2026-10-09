import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRouteTeacher } from "@/lib/auth/dal";
import { deleteScanRow } from "@/lib/db/repos/scans";
import { AppError } from "@/lib/errors";
import type { Teacher } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedScan, seedTeacher, useTestDb } from "@/test/helpers";
import { GET } from "./route";

// Route handlers read the session cookie through next/headers, which needs a live request; the signed-in
// teacher is supplied here instead, and the ownership check runs for real.
vi.mock("@/lib/auth/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/dal")>()),
  requireRouteTeacher: vi.fn(),
}));

let teacher: Teacher;

beforeEach(() => {
  useTestDb();
  teacher = seedTeacher();
  vi.mocked(requireRouteTeacher).mockResolvedValue(teacher);
});

function fetchPdf(scanId: string, ifNoneMatch?: string): Promise<Response> {
  const headers = ifNoneMatch === undefined ? undefined : { "If-None-Match": ifNoneMatch };
  return GET(new NextRequest(`http://localhost:3000/api/teacher/scans/${scanId}/pdf`, { headers }), { params: Promise.resolve({ scanId }) });
}

async function seededScan(teacherId: string) {
  const assignment = seedAssignment(teacherId);
  seedApprovedKey(assignment.id, [{}]);
  return seedScan(assignment.id, { pages: 2 });
}

describe("GET /api/teacher/scans/[scanId]/pdf", () => {
  it("serves the owner's scan, kept by the browser only and revalidated on every use", async () => {
    const scan = await seededScan(teacher.id);
    const res = await fetchPdf(scan.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("ETag")).toBe(`"${scan.contentSha256}"`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from(await makePdf(2)));
  });

  it.each([
    ["the plain tag", (etag: string) => etag],
    ["a weak tag", (etag: string) => `W/${etag}`],
    ["a list containing the tag", (etag: string) => `"0000", ${etag} , W/"ffff"`],
    ["*", () => "*"],
  ])("answers 304 with no body for If-None-Match with %s", async (_label, header) => {
    const scan = await seededScan(teacher.id);
    const etag = `"${scan.contentSha256}"`;
    const res = await fetchPdf(scan.id, header(etag));
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.body).toBeNull();
  });

  it("sends the full scan when If-None-Match names other content", async () => {
    const scan = await seededScan(teacher.id);
    const res = await fetchPdf(scan.id, `"${"0".repeat(64)}", W/"${scan.contentSha256.slice(1)}"`);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(`"${scan.contentSha256}"`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from(await makePdf(2)));
  });

  // A browser revalidating a copy it kept must not be told "still fresh" once the session or the ownership is gone.
  it("checks ownership before answering 304", async () => {
    const theirs = await seededScan(seedTeacher().id);
    const res = await fetchPdf(theirs.id, `"${theirs.contentSha256}"`);
    expect(res.status).toBe(404);
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("checks the sign-in before answering 304", async () => {
    const scan = await seededScan(teacher.id);
    vi.mocked(requireRouteTeacher).mockRejectedValue(new AppError("unauthorized", "Log in to continue."));
    const res = await fetchPdf(scan.id, `"${scan.contentSha256}"`);
    expect(res.status).toBe(401);
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("answers 404 with the old tag once the scan is deleted", async () => {
    const scan = await seededScan(teacher.id);
    deleteScanRow(scan.id);
    expect((await fetchPdf(scan.id, `"${scan.contentSha256}"`)).status).toBe(404);
  });

  it("answers 404 for another teacher's scan and for a malformed id", async () => {
    const theirs = await seededScan(seedTeacher().id);
    expect((await fetchPdf(theirs.id)).status).toBe(404);
    expect((await fetchPdf("../../etc/passwd")).status).toBe(404);
  });
});
