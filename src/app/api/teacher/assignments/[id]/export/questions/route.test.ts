import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRouteTeacher } from "@/lib/auth/dal";
import { AppError } from "@/lib/errors";
import type { Teacher } from "@/lib/types";
import { seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import { GET } from "./route";

// Route handlers read the session cookie through next/headers, which needs a live request; the signed-in
// teacher is supplied here instead, and the ownership check runs for real.
vi.mock("@/lib/auth/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/dal")>()),
  requireRouteTeacher: vi.fn(),
}));

// connection() needs a live request too; outside one there is nothing to wait for.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: vi.fn(() => Promise.resolve()),
}));

let teacher: Teacher;

beforeEach(() => {
  useTestDb();
  teacher = seedTeacher();
  vi.mocked(requireRouteTeacher).mockResolvedValue(teacher);
});

function fetchCsv(id: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost:3000/api/teacher/assignments/${id}/export/questions`), { params: Promise.resolve({ id }) });
}

describe("GET /api/teacher/assignments/[id]/export/questions", () => {
  it("sends the owner's question stats as a CSV download, a formula-looking prompt defused", async () => {
    const assignment = seedAssignment(teacher.id, { title: "Unit 4 Quiz" });
    seedApprovedKey(assignment.id, [{ prompt: "=SUM(A1)" }, {}]);
    const res = await fetchCsv(assignment.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="unit-4-quiz-questions.csv"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const lines = (await res.text()).replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^"1","","'=SUM\(A1\)","1","0","0","0","0","0","0","","","","",""$/);
  });

  it("answers 401 when signed out and 404 for another teacher's assignment or a malformed id", async () => {
    const theirs = seedAssignment(seedTeacher().id);
    expect((await fetchCsv(theirs.id)).status).toBe(404);
    expect((await fetchCsv("../../etc")).status).toBe(404);
    vi.mocked(requireRouteTeacher).mockRejectedValue(new AppError("unauthorized", "Log in to continue."));
    expect((await fetchCsv(seedAssignment(teacher.id).id)).status).toBe(401);
  });
});
