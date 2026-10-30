import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRouteTeacher } from "@/lib/auth/dal";
import { listItems } from "@/lib/db/repos/submissions";
import { drainQueue } from "@/lib/jobs/test-utils";
import { makeMarkedPaper, makeWorksheet, MIXED_WORKSHEET } from "@/lib/omr/fixtures";
import { ingestTeacherUpload } from "@/lib/services/submissions";
import { ingestBlankWorksheet, saveSpots } from "@/lib/services/worksheets";
import type { Teacher } from "@/lib/types";
import { seedApprovedKey, seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import { GET } from "./route";

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

function fetchCrop(submissionId: string, itemId: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost:3000/api/teacher/submissions/${submissionId}/spots/${itemId}`), {
    params: Promise.resolve({ submissionId, itemId }),
  });
}

async function gradedPaper() {
  const assignment = seedAssignment(teacher.id);
  const items = seedApprovedKey(assignment.id, [
    { label: "1", answerType: "multiple_choice", expectedAnswer: "B" },
    { label: "2", answerType: "true_false", expectedAnswer: "True" },
    { label: "7", answerType: "short_answer", expectedAnswer: "x" },
  ]);
  const worksheet = await makeWorksheet(MIXED_WORKSHEET);
  const ws = await ingestBlankWorksheet(assignment, [{ filename: "blank.pdf", bytes: worksheet.pdf }]);
  saveSpots(assignment, ws.spots);
  const paper = await makeMarkedPaper(worksheet, [{ q: "1", circle: "B" }], { warp: { dx: 4, dy: 3, rotate: 0.5 } });
  const { submissionId } = await ingestTeacherUpload(assignment, [{ filename: "p.pdf", bytes: paper }]);
  await drainQueue();
  return { submissionId, items };
}

describe("GET /api/teacher/submissions/[submissionId]/spots/[itemId]", () => {
  it("renders the owner's answer-spot crop as a private PNG", async () => {
    const { submissionId, items } = await gradedPaper();
    expect(listItems(submissionId).find((row) => row.itemId === items[0].id)?.judgment?.spot?.marked).toEqual(["B"]);
    const res = await fetchCrop(submissionId, items[0].id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toMatch(/^private/);
    const png = new Uint8Array(await res.arrayBuffer());
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("is 404 for an item the AI read, and for another teacher's paper", async () => {
    const { submissionId, items } = await gradedPaper();
    expect((await fetchCrop(submissionId, items[2].id)).status).toBe(404);
    vi.mocked(requireRouteTeacher).mockResolvedValue(seedTeacher({ email: "other@example.com" }));
    expect((await fetchCrop(submissionId, items[0].id)).status).toBe(404);
  });
});
