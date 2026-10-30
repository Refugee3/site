import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = path.dirname(new URL(import.meta.url).pathname);

/** Every route under src/app, as its URL pattern ("/teacher/assignments/[id]", "/api/health"). */
function routes(dir = APP_DIR, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return routes(path.join(dir, entry.name), `${prefix}/${entry.name}`);
    return /^(page|route)\.tsx?$/.test(entry.name) ? [prefix || "/"] : [];
  });
}

describe("routes", () => {
  it("serves teachers only: no student upload, receipt or code pages, and nothing public but log in and sign up", () => {
    const all = routes();
    expect(all).toContain("/");
    expect(all).toContain("/login");
    expect(all).toContain("/signup");
    expect(all).toContain("/teacher");
    for (const gone of ["/s/[code]", "/r/[token]", "/go", "/api/s/[code]/submissions", "/api/r/[token]/pdf"]) {
      expect(all).not.toContain(gone);
    }
    expect(all.filter((route) => !route.startsWith("/teacher") && !route.startsWith("/api/teacher")).sort()).toEqual(
      ["/", "/api/health", "/login", "/signup"],
    );
  });
});
