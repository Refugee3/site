import fs from "node:fs";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(new URL("./globals.css", import.meta.url), "utf8");

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})\\s*;`, "i").exec(css);
  if (!match) throw new Error(`--color-${name} is not a 6-digit hex color in globals.css`);
  return match[1];
}

/** WCAG 2 relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe("theme tokens", () => {
  it("computes contrast the WCAG way", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  // Form fields (inputs, selects, the share-code box) are only marked by their border (WCAG 1.4.11).
  it.each(["surface", "canvas", "subtle", "warning-50", "brand-50", "info-50", "danger-50", "success-50"])(
    "keeps control borders at 3:1 or more on %s",
    (background) => {
      expect(contrast(token("line-control"), token(background))).toBeGreaterThanOrEqual(3);
    },
  );
});
