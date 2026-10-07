import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRouteTeacher } from "@/lib/auth/dal";
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

function fetchPdf(scanId: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost:3000/api/teacher/scans/${scanId}/pdf`), { params: Promise.resolve({ scanId }) });
}

async function seededScan(teacherId: string) {
  const assignment = seedAssignment(teacherId);
  seedApprovedKey(assignment.id, [{}]);
  return seedScan(assignment.id, { pages: 2 });
}

describe("GET /api/teacher/scans/[scanId]/pdf", () => {
  it("serves the owner's scan, cacheable by the browser only", async () => {
    const scan = await seededScan(teacher.id);
    const res = await fetchPdf(scan.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from(await makePdf(2)));
  });

  it("answers 404 for another teacher's scan and for a malformed id", async () => {
    const theirs = await seededScan(seedTeacher().id);
    expect((await fetchPdf(theirs.id)).status).toBe(404);
    expect((await fetchPdf("../../etc/passwd")).status).toBe(404);
  });
});
