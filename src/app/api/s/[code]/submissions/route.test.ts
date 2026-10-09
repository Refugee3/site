import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { setStudentsCanUpload } from "@/lib/db/repos/settings";
import { countSubmissions } from "@/lib/db/repos/submissions";
import { countStudentSubmission } from "@/lib/http/rate-limit";
import { newShareCode } from "@/lib/ids";
import { UPLOADS_OFF_MESSAGE } from "@/lib/services/settings";
import type { Assignment } from "@/lib/types";
import { enableStudentUploads, makePdf, seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import { POST } from "./route";

let open: Assignment;
let other: Assignment;

beforeEach(() => {
  useTestDb();
  const teacherId = seedTeacher().id;
  open = seedAssignment(teacherId, { status: "open" });
  other = seedAssignment(teacherId, { status: "open" });
  seedApprovedKey(open.id, [{}]);
  seedApprovedKey(other.id, [{}]);
  enableStudentUploads();
});

/** A POST to the upload route from `ip`; without `body`, an empty (invalid) one. */
function upload(code: string, ip: string, body?: FormData): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/s/${code}/submissions`, {
    method: "POST",
    headers: { "x-forwarded-for": ip, host: "localhost:3000" },
    body: body ?? null,
  });
  return POST(req, { params: Promise.resolve({ code }) });
}

let papers = 0;

/** A form with one distinct, valid PDF (distinct bytes, so it is never a duplicate). */
async function paper(): Promise<FormData> {
  const fd = new FormData();
  const bytes = await makePdf(1, { label: `paper ${papers++}` });
  fd.append("files", new File([Uint8Array.from(bytes)], "work.pdf", { type: "application/pdf" }));
  return fd;
}

describe("POST /api/s/[code]/submissions rate limits", () => {
  it("accepts a valid upload", async () => {
    const res = await upload(open.shareCode, "203.0.113.7", await paper());
    expect(res.status).toBe(201);
    expect(countSubmissions(open.id)).toBe(1);
  });

  it("does not let a spray of unknown codes block anyone else's uploads", async () => {
    for (let i = 0; i < 1000; i++) {
      const res = await upload(newShareCode(), `10.0.${Math.floor(i / 50)}.${i % 50}`);
      expect(res.status).toBe(404);
    }
    expect((await upload(open.shareCode, "192.168.1.1", await paper())).status).toBe(201);
  });

  it("refuses an address that keeps guessing codes, even for a real code, and nobody else", async () => {
    for (let i = 0; i < 60; i++) expect((await upload(newShareCode(), "198.51.100.9")).status).toBe(404);
    const refused = await upload(open.shareCode, "198.51.100.9", await paper());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect((await upload(open.shareCode, "198.51.100.10", await paper())).status).toBe(201);
  });

  it("does not let junk to one assignment block that address's uploads elsewhere or use up the shared budgets", async () => {
    for (let i = 0; i < 60; i++) {
      const res = await upload(open.shareCode, "203.0.113.5");
      expect(res.status).toBe(400);
    }
    expect((await upload(other.shareCode, "203.0.113.5", await paper())).status).toBe(201);
    expect((await upload(open.shareCode, "203.0.113.5", await paper())).status).toBe(201);

    // The 60 rejected uploads did not count against the assignment's 300 per hour (1 real one did).
    for (let i = 0; i < 298; i++) countStudentSubmission(open.shareCode);
    expect((await upload(open.shareCode, "203.0.113.6", await paper())).status).toBe(201);
    const full = await upload(open.shareCode, "203.0.113.6", await paper());
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("refuses a full assignment budget before reading the body", async () => {
    for (let i = 0; i < 300; i++) countStudentSubmission(open.shareCode);
    const res = await upload(open.shareCode, "203.0.113.7", await paper());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(countSubmissions(open.id)).toBe(0);
  });
});

describe("POST /api/s/[code]/submissions while student uploads are off", () => {
  beforeEach(() => setStudentsCanUpload(false));

  it("refuses before reading the body, with the same answer for real and unknown codes", async () => {
    let bodyRead = false;
    // highWaterMark 0: the stream is pulled only when someone reads it.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyRead = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const req = new NextRequest(`http://localhost:3000/api/s/${open.shareCode}/submissions`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7", host: "localhost:3000" },
      body,
      duplex: "half",
    });
    const res = await POST(req, { params: Promise.resolve({ code: open.shareCode }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "closed", message: UPLOADS_OFF_MESSAGE } });
    expect(bodyRead).toBe(false);

    const unknown = await upload(newShareCode(), "203.0.113.7");
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({ error: { code: "closed", message: UPLOADS_OFF_MESSAGE } });
    expect(countSubmissions(open.id)).toBe(0);
  });

  it("counts no lookup misses, so an address is not refused once uploads are back on", async () => {
    for (let i = 0; i < 61; i++) expect((await upload(newShareCode(), "198.51.100.9")).status).toBe(403);
    enableStudentUploads();
    expect((await upload(open.shareCode, "198.51.100.9", await paper())).status).toBe(201);
    expect(countSubmissions(open.id)).toBe(1);
  });
});
