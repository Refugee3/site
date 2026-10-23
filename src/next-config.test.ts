import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config headers", () => {
  it("sends Referrer-Policy: same-origin, so no-JS form posts carry a real Origin (not null) for the server-action check", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((rule) => rule.source === "/:path*");
    expect(all?.headers).toContainEqual({ key: "Referrer-Policy", value: "same-origin" });
  });
});
