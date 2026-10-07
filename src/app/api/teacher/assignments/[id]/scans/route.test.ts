import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseScanUploadResult } from "@/components/teacher/scan-upload-result";
import { requireRouteTeacher } from "@/lib/auth/dal";
import { resetConfigForTests } from "@/lib/config";
import { getScan, listScans } from "@/lib/db/repos/scans";
import { AppError } from "@/lib/errors";
import type { Assignment, Teacher } from "@/lib/types";
import { makePdf, seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import { POST } from "./route";

// Route handlers read the session cookie through next/headers, which needs a live request; the signed-in
// teacher is supplied here instead, and everything after it (ownership, origin, key, body) runs for real.
vi.mock("@/lib/auth/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/dal")>()),
  requireRouteTeacher: vi.fn(),
}));

let teacher: Teacher;
let assignment: Assignment;

beforeEach(() => {
  useTestDb();
  teacher = seedTeacher();
  assignment = seedAssignment(teacher.id);
  seedApprovedKey(assignment.id, [{ page: 1 }, { page: 2 }]);
  vi.mocked(requireRouteTeacher).mockResolvedValue(teacher);
});

async function scanForm(pages = 4): Promise<FormData> {
  const fd = new FormData();
  fd.append("file", new File([Uint8Array.from(await makePdf(pages))], "stack.pdf", { type: "application/pdf" }));
  return fd;
}

function upload(
  query: string,
  body: FormData | ReadableStream<Uint8Array>,
  o: { id?: string; origin?: string } = {},
): Promise<Response> {
  const id = o.id ?? assignment.id;
  const req = new NextRequest(`http://localhost:3000/api/teacher/assignments/${id}/scans?${query}`, {
    method: "POST",
    headers: { host: "localhost:3000", origin: o.origin ?? "http://localhost:3000" },
    body,
    duplex: "half",
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

/** A body that records whether the handler started reading it (pulled only on read). */
function trackedBody(): { body: ReadableStream<Uint8Array>; read: () => boolean } {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, read: () => pulled };
}

describe("POST /api/teacher/assignments/[id]/scans", () => {
  it("stores an automatic scan for the AI to split and answers with its review page", async () => {
    const res = await upload("mode=auto", await scanForm());
    expect(res.status).toBe(201);
    const result = parseScanUploadResult(await res.json());
    expect(result).not.toBeNull();
    expect(result?.reviewUrl).toBe(`/teacher/assignments/${assignment.id}/scans/${result?.scanId}`);
    expect(getScan(result?.scanId ?? "")).toMatchObject({ status: "splitting", splitMode: "auto", pageCount: 4, layout: null });
  });

  it("splits every N pages at once when asked", async () => {
    const res = await upload("mode=every&pagesPerPaper=2", await scanForm());
    expect(res.status).toBe(201);
    const { scanId } = (await res.json()) as { scanId: string };
    const scan = getScan(scanId);
    expect(scan).toMatchObject({ status: "review", splitMode: "every", pagesPerPaper: 2 });
    expect(scan?.layout?.map((page) => page.startsPaper)).toEqual([true, false, true, false]);
  });

  it("refuses a bad split choice before reading the body", async () => {
    const queries = [
      "", "mode=half", "mode=every", "mode=every&pagesPerPaper=0", "mode=every&pagesPerPaper=101",
      "mode=every&pagesPerPaper=2.5", "mode=every&pagesPerPaper=x",
    ];
    for (const query of queries) {
      const tracked = trackedBody();
      const res = await upload(query, tracked.body);
      expect(res.status, query).toBe(400);
      expect(await res.json(), query).toMatchObject({ error: { code: "validation" } });
      expect(tracked.read(), query).toBe(false);
    }
    expect(listScans(assignment.id)).toEqual([]);
  });

  it("refuses before reading the body while the key is not approved", async () => {
    const draft = seedAssignment(teacher.id);
    const tracked = trackedBody();
    const res = await upload("mode=auto", tracked.body, { id: draft.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "key_not_ready" } });
    expect(tracked.read()).toBe(false);
  });

  it("answers 404 for another teacher's assignment and for a malformed id", async () => {
    const theirs = seedAssignment(seedTeacher().id);
    seedApprovedKey(theirs.id, [{}]);
    expect((await upload("mode=auto", await scanForm(), { id: theirs.id })).status).toBe(404);
    expect((await upload("mode=auto", await scanForm(), { id: "not-an-id" })).status).toBe(404);
    expect(listScans(theirs.id)).toEqual([]);
  });

  it("refuses a request from another site", async () => {
    const res = await upload("mode=auto", await scanForm(), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(listScans(assignment.id)).toEqual([]);
  });

  it("answers 401 without a signed-in teacher", async () => {
    vi.mocked(requireRouteTeacher).mockRejectedValue(new AppError("unauthorized", "Log in to continue."));
    expect((await upload("mode=auto", await scanForm())).status).toBe(401);
  });

  it("limits a scan's size by MAX_SCAN_MB, not by a single paper's MAX_UPLOAD_MB", async () => {
    vi.stubEnv("MAX_UPLOAD_MB", "1");
    vi.stubEnv("MAX_SCAN_MB", "2");
    resetConfigForTests();
    const big = new Uint8Array(3 * 1_048_576);
    const fd = new FormData();
    fd.append("file", new File([big], "huge.pdf", { type: "application/pdf" }));
    const res = await upload("mode=auto", fd);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "too_large" } });

    const fits = new FormData();
    fits.append("file", new File([new Uint8Array(1_500_000)], "junk.pdf", { type: "application/pdf" }));
    // Past the size limits, so the PDF check is what refuses it.
    expect((await upload("mode=auto", fits)).status).toBe(422);
  });

  it("refuses the same scan twice", async () => {
    const fd = await scanForm();
    expect((await upload("mode=auto", fd)).status).toBe(201);
    const again = await upload("mode=auto", fd);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "duplicate" } });
  });
});
