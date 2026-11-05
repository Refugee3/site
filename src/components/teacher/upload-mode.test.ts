import { describe, expect, it } from "vitest";
import { detectUploadMode, PACKET_FACTOR } from "./upload-mode";

describe("detectUploadMode", () => {
  it("takes several files for one paper per student, whatever their length", () => {
    expect(detectUploadMode({ fileCount: 6, isPdf: true, pageCount: 40, keyPageCount: 1 }))
      .toEqual({ mode: "per_student", why: "6 files: one paper per student." });
  });

  it("takes one PDF more than 1.5× the key's pages for the whole class", () => {
    expect(PACKET_FACTOR).toBe(1.5);
    expect(detectUploadMode({ fileCount: 1, isPdf: true, pageCount: 9, keyPageCount: 1 })).toEqual({
      mode: "packet", why: "One PDF of 9 pages, and the answer key has 1 page: the whole class scanned together.",
    });
    expect(detectUploadMode({ fileCount: 1, isPdf: true, pageCount: 4, keyPageCount: 2 }).mode).toBe("packet");
  });

  it("takes one PDF up to 1.5× the key's pages for one student's paper", () => {
    expect(detectUploadMode({ fileCount: 1, isPdf: true, pageCount: 3, keyPageCount: 2 })).toEqual({
      mode: "per_student", why: "One PDF of 3 pages, about as long as the answer key: one student's paper.",
    });
    expect(detectUploadMode({ fileCount: 1, isPdf: true, pageCount: 1, keyPageCount: 1 }).mode).toBe("per_student");
  });

  it("defaults to one student's paper for a photo, a Word file, an uncountable PDF or a key of unknown length", () => {
    expect(detectUploadMode({ fileCount: 1, isPdf: false, pageCount: null, keyPageCount: 1 }).mode).toBe("per_student");
    expect(detectUploadMode({ fileCount: 1, isPdf: true, pageCount: null, keyPageCount: 1 }).mode).toBe("per_student");
    expect(detectUploadMode({ fileCount: 1, isPdf: true, pageCount: 30, keyPageCount: null })).toEqual({
      mode: "per_student", why: "One PDF of 30 pages: one student's paper.",
    });
  });
});
