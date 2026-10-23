import { describe, expect, it } from "vitest";
import { safeNextPath, TEACHER_HOME } from "@/lib/auth/next-path";

describe("safeNextPath", () => {
  it("keeps a teacher page with its query", () => {
    const page = "/teacher/assignments/0f8fad5b-d9cb-469f-a165-70867728950e/submissions/7c9e6679-7425-40de-944b-e07fc1f90ae7?x=1";
    expect(safeNextPath(page)).toBe(page);
    expect(safeNextPath("/teacher")).toBe("/teacher");
    expect(safeNextPath("/teacher?tab=all")).toBe("/teacher?tab=all");
  });

  it.each([
    null,
    undefined,
    "",
    "/",
    "/login",
    "/teachers",
    "/teacher-evil",
    "/teacher/../login",
    "/teacher/..//evil.com",
    "/teacher/%2e%2e/login",
    "/teacher/%2E%2E/%2e%2e//evil.com",
    "/teacher\\..\\login",
    "/teacher/..\\..\\/evil.com",
    "//evil.com",
    "//evil.com/teacher",
    "https://evil.com",
    "https://evil.com/teacher",
    "javascript:alert(1)",
    "teacher",
    "/teacher#frag/../../login",
  ])("sends %j to the teacher home", (hostile) => {
    expect(safeNextPath(hostile)).toBe(TEACHER_HOME);
  });

  it("never lets line breaks or control characters through to the Location header", () => {
    const next = safeNextPath("/teacher?x=1\r\nSet-Cookie: a=b\u0000\u0007");
    expect(next.startsWith("/teacher?x=1")).toBe(true);
    expect(next).not.toMatch(/[\u0000-\u001f\u007f ]/);
    expect(safeNextPath("/teacher/\r\n/evil")).toMatch(/^\/teacher\//);
  });
});
