import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as views from "@/lib/services/views";
import type { Assignment } from "@/lib/types";
import { seedAssignment, seedTeacher, useTestDb } from "@/test/helpers";
import { GET } from "./route";

let assignment: Assignment;

beforeEach(() => {
  useTestDb();
  assignment = seedAssignment(seedTeacher().id, { status: "open" });
});

function lookUp(code: string, ip = "203.0.113.7"): Promise<Response> {
  const url = `http://localhost:3000/go?code=${encodeURIComponent(code)}`;
  return GET(new NextRequest(url, { headers: { "x-forwarded-for": ip } }));
}

async function expectRedirect(res: Promise<Response>, location: string): Promise<void> {
  const r = await res;
  expect(r.status).toBe(303);
  expect(r.headers.get("Location")).toBe(location);
}

describe("GET /go", () => {
  it("sends a known code, in any spelling, to its page and anything else back to the box", async () => {
    const spaced = `${assignment.shareCode.slice(0, 3)}-${assignment.shareCode.slice(3)}`.toLowerCase();
    await expectRedirect(lookUp(spaced), `/s/${assignment.shareCode}`);
    await expectRedirect(lookUp("ZZZZZZ"), "/?error=code");
    await expectRedirect(lookUp("no"), "/?error=code");
  });

  it("lets a school behind one address look up real codes as often as it likes", async () => {
    for (let i = 0; i < 100; i++) await expectRedirect(lookUp(assignment.shareCode), `/s/${assignment.shareCode}`);
  });

  it("after 60 misses in a minute, redirects every lookup from that address to a friendly error, never JSON", async () => {
    for (let i = 0; i < 60; i++) await expectRedirect(lookUp("ZZZZZZ"), "/?error=code");
    await expectRedirect(lookUp(assignment.shareCode), "/?error=rate");
    await expectRedirect(lookUp(assignment.shareCode, "203.0.113.8"), `/s/${assignment.shareCode}`);
  });

  it("does not count malformed codes, which reveal nothing", async () => {
    for (let i = 0; i < 100; i++) await expectRedirect(lookUp("x"), "/?error=code");
    await expectRedirect(lookUp(assignment.shareCode), `/s/${assignment.shareCode}`);
  });

  it("redirects to a server error instead of answering with JSON when the lookup fails", async () => {
    const spy = vi.spyOn(views, "getStudentUploadView").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expectRedirect(lookUp(assignment.shareCode), "/?error=server");
      expect(log).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
  });
});
