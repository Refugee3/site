import { describe, expect, it } from "vitest";
import { formatBytes, isPdfFile, moveItem } from "./upload-files";

describe("moveItem", () => {
  it("swaps an item with its neighbour without mutating the input", () => {
    const items = ["a", "b", "c"];
    expect(moveItem(items, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(items, 1, 1)).toEqual(["a", "c", "b"]);
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("ignores moves past either end or from a bad index", () => {
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 5, -1)).toEqual(["a", "b"]);
  });
});

describe("isPdfFile", () => {
  it("goes by MIME type or extension", () => {
    expect(isPdfFile({ name: "work.pdf", type: "application/pdf" })).toBe(true);
    expect(isPdfFile({ name: "SCAN.PDF", type: "" })).toBe(true);
    expect(isPdfFile({ name: "photo.jpg", type: "image/jpeg" })).toBe(false);
    expect(isPdfFile({ name: "IMG_1.HEIC", type: "image/heic" })).toBe(false);
  });
});

describe("formatBytes", () => {
  it("uses KB below a megabyte and one decimal of MB above", () => {
    expect(formatBytes(0)).toBe("1 KB");
    expect(formatBytes(300 * 1024)).toBe("300 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(23.45 * 1024 * 1024)).toBe("23.4 MB");
  });
});
