import { describe, expect, it } from "vitest";
import { AiError } from "@/lib/ai/errors";
import type { PacketOutput, PacketPaper } from "@/lib/ai/schemas";
import {
  BOUNDARY_NOTES, chunkPageCount, hasOnePassProgress, interpretChunk, planChunk, smallerChunk, splitUsage, type ChunkContext,
} from "./packet";

/** A paper on chunk pages first..last, graded with one item on its first page. */
function paper(first: number, last: number, o: Partial<PacketPaper> = {}): PacketPaper {
  return {
    first_page: first, last_page: last, continues_from_previous_chunk: false, may_continue_after_chunk: false,
    boundary_confidence: "high",
    student: { name: `Student ${first}`, name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false },
    document_check: { match: "matches", pages_appear_missing: false, note: "" },
    items: [{
      ref: "Q1", pages: [first, last], student_answer: "4", legibility: "clear", attempt: "complete", correctness: "correct",
      confidence: "high", review_reason: "none", what_student_did: "", feedback: "", teacher_note: "",
    }],
    integrity: { grader_directed_text_found: false, excerpt: "" },
    unmatched_work: "", overall_feedback: "", teacher_summary: "",
    ...o,
  };
}

function output(papers: PacketPaper[], skipped: PacketOutput["skipped_pages"] = []): PacketOutput {
  return { papers, skipped_pages: skipped };
}

/** Chunk pages 10–18 of a 40-page scan, after a chunk that ended cleanly. */
const middle: ChunkContext = { firstPage: 10, lastPage: 18, totalPages: 40, previousEndedCleanly: true };

/** [first, last] scan pages of each paper. */
function ranges(c: ReturnType<typeof interpretChunk>): Array<[number, number]> {
  return c.papers.map((p) => [p.firstPage, p.lastPage]);
}

describe("chunkPageCount", () => {
  it("holds whole papers when the key tells their length", () => {
    expect(chunkPageCount({ keyPageCount: 3, maxPages: 18 })).toBe(18);
    expect(chunkPageCount({ keyPageCount: 4, maxPages: 18 })).toBe(16);
    expect(chunkPageCount({ keyPageCount: 5, maxPages: 18 })).toBe(15);
    expect(chunkPageCount({ keyPageCount: 1, maxPages: 18 })).toBe(18);
  });

  it("uses the maximum when the key doesn't tell or a paper is longer than a chunk", () => {
    expect(chunkPageCount({ keyPageCount: null, maxPages: 18 })).toBe(18);
    expect(chunkPageCount({ keyPageCount: 25, maxPages: 18 })).toBe(18);
  });

  it("follows a lower override, still in whole papers", () => {
    expect(chunkPageCount({ keyPageCount: 3, maxPages: 18, override: 9 })).toBe(9);
    expect(chunkPageCount({ keyPageCount: 4, maxPages: 18, override: 8 })).toBe(8);
    expect(chunkPageCount({ keyPageCount: 4, maxPages: 18, override: 3 })).toBe(3);
    expect(chunkPageCount({ keyPageCount: null, maxPages: 18, override: null })).toBe(18);
  });
});

describe("planChunk", () => {
  it("plans the pages from the next page, stopping at the scan's end", () => {
    expect(planChunk(1, 84, 18)).toEqual({ firstPage: 1, lastPage: 18 });
    expect(planChunk(73, 84, 18)).toEqual({ firstPage: 73, lastPage: 84 });
    expect(planChunk(84, 84, 18)).toEqual({ firstPage: 84, lastPage: 84 });
    expect(planChunk(85, 84, 18)).toBeNull();
  });
});

describe("smallerChunk", () => {
  it("halves in whole papers while more than one fits, then by pages", () => {
    expect(smallerChunk(18, 3)).toBe(9);
    expect(smallerChunk(9, 3)).toBe(3);
    expect(smallerChunk(6, 3)).toBe(3);
    expect(smallerChunk(3, 3)).toBe(2);
    expect(smallerChunk(18, null)).toBe(9);
    expect(smallerChunk(2, null)).toBe(1);
    expect(smallerChunk(1, 3)).toBeNull();
  });
});

describe("interpretChunk", () => {
  it("turns papers that tile the chunk into scan pages, with item pages counted from each paper's first page", () => {
    const chunk = interpretChunk(output([paper(1, 3), paper(4, 6), paper(7, 9)]), middle);
    expect(ranges(chunk)).toEqual([[10, 12], [13, 15], [16, 18]]);
    expect(chunk.papers.map((p) => p.output.items[0].pages)).toEqual([[1, 3], [1, 3], [1, 3]]);
    expect(chunk.papers.map((p) => p.output.student.name)).toEqual(["Student 1", "Student 4", "Student 7"]);
    expect(chunk.papers.every((p) => p.boundaryNotes.length === 0)).toBe(true);
    expect(chunk).toMatchObject({ skipped: [], nextPage: 19, endedCleanly: true, carriedOver: false });
    // The grading carries no boundary fields: it is stored like any paper's.
    expect(Object.keys(chunk.papers[0].output)).toEqual([
      "student", "document_check", "items", "integrity", "unmatched_work", "overall_feedback", "teacher_summary",
    ]);
  });

  it("drops a last paper that may go on after the chunk, and starts the next chunk on its first page", () => {
    const chunk = interpretChunk(output([paper(1, 3), paper(4, 6), paper(7, 9, { may_continue_after_chunk: true })]), middle);
    expect(ranges(chunk)).toEqual([[10, 12], [13, 15]]);
    expect(chunk).toMatchObject({ nextPage: 16, endedCleanly: true, carriedOver: true, skipped: [] });
  });

  it("keeps a paper that fills the whole chunk and may go on (no progress otherwise), flagged, and ends uncleanly", () => {
    const chunk = interpretChunk(output([paper(1, 9, { may_continue_after_chunk: true })]), middle);
    expect(ranges(chunk)).toEqual([[10, 18]]);
    expect(chunk).toMatchObject({ nextPage: 19, endedCleanly: false, carriedOver: false });
    expect(chunk.papers[0].boundaryNotes).toEqual([BOUNDARY_NOTES.tooLong(18, 9)]);
  });

  it("ignores may_continue_after_chunk on the scan's last chunk", () => {
    const last = { ...middle, lastPage: 18, totalPages: 18 };
    const chunk = interpretChunk(output([paper(1, 4), paper(5, 9, { may_continue_after_chunk: true })]), last);
    expect(ranges(chunk)).toEqual([[10, 13], [14, 18]]);
    expect(chunk).toMatchObject({ nextPage: 19, endedCleanly: true, carriedOver: false });
  });

  it("flags a first paper that continues from before the chunk: a misread after a clean end, the rest of a long paper otherwise", () => {
    const papers = [paper(1, 2, { continues_from_previous_chunk: true }), paper(3, 9)];
    const afterClean = interpretChunk(output(papers), middle);
    expect(afterClean.papers.map((p) => p.boundaryNotes)).toEqual([[BOUNDARY_NOTES.continues(10)], []]);
    const afterLong = interpretChunk(output(papers), { ...middle, previousEndedCleanly: false });
    expect(afterLong.papers[0].boundaryNotes).toEqual([BOUNDARY_NOTES.restOfLongPaper(10)]);
    // The scan's first chunk has nothing before it.
    const first = interpretChunk(output(papers), { ...middle, firstPage: 1, lastPage: 9 });
    expect(first.papers[0].boundaryNotes).toEqual([]);
  });

  it("flags a paper whose boundaries the AI wasn't sure of", () => {
    const chunk = interpretChunk(output([paper(1, 4, { boundary_confidence: "low" }), paper(5, 9, { boundary_confidence: "medium" })]), middle);
    expect(chunk.papers.map((p) => p.boundaryNotes)).toEqual([[BOUNDARY_NOTES.lowConfidence], []]);
  });

  it("reports skipped pages with the AI's reason, and pages in no paper as unassigned, flagging the paper before them", () => {
    const chunk = interpretChunk(output([paper(1, 3), paper(5, 7), paper(8, 9)], [{ page: 4, kind: "blank" }]), middle);
    expect(chunk.skipped).toEqual([{ page: 13, reason: "blank" }]);
    expect(chunk.papers.every((p) => p.boundaryNotes.length === 0)).toBe(true);

    const gap = interpretChunk(output([paper(1, 3), paper(6, 9)], [{ page: 4, kind: "cover_or_separator" }]), middle);
    expect(gap.skipped).toEqual([{ page: 13, reason: "cover_or_separator" }, { page: 14, reason: "unassigned" }]);
    expect(gap.papers.map((p) => p.boundaryNotes)).toEqual([[BOUNDARY_NOTES.unassigned([14])], []]);

    // A page in no paper before the first paper flags the paper after it.
    const leading = interpretChunk(output([paper(2, 9)]), middle);
    expect(leading.skipped).toEqual([{ page: 10, reason: "unassigned" }]);
    expect(leading.papers[0].boundaryNotes).toEqual([BOUNDARY_NOTES.unassigned([10])]);
  });

  it("reads trailing pages in no paper again with the next chunk", () => {
    const chunk = interpretChunk(output([paper(1, 3), paper(4, 6)]), middle);
    expect(chunk).toMatchObject({ nextPage: 16, skipped: [], endedCleanly: true });
    // Skipped (blank) trailing pages are done with.
    const blank = interpretChunk(output([paper(1, 3), paper(4, 6)], [7, 8, 9].map((page) => ({ page, kind: "blank" as const }))), middle);
    expect(blank.nextPage).toBe(19);
    // On the scan's last chunk they are left out instead.
    const last = interpretChunk(output([paper(1, 3), paper(4, 6)]), { ...middle, totalPages: 18 });
    expect(last.nextPage).toBe(19);
    expect(last.skipped.map((s) => s.page)).toEqual([16, 17, 18]);
  });

  it("drops the carried-over paper's pages from the skipped pages: the next chunk reads them", () => {
    const chunk = interpretChunk(output([paper(1, 3), paper(5, 8, { may_continue_after_chunk: true })], [{ page: 4, kind: "blank" }, { page: 9, kind: "blank" }]), middle);
    expect(chunk.skipped).toEqual([{ page: 13, reason: "blank" }]);
    expect(chunk.nextPage).toBe(14);
  });

  it("clamps, rounds and sorts pages, cuts overlaps, and drops a paper inside another", () => {
    const chunk = interpretChunk(output([paper(7.2, 12), paper(0, 3.4), paper(3, 6), paper(4, 5)]), middle);
    expect(ranges(chunk)).toEqual([[10, 12], [13, 15], [16, 18]]);
    expect(chunk.papers.map((p) => p.boundaryNotes)).toEqual([[BOUNDARY_NOTES.overlap], [BOUNDARY_NOTES.overlap], []]);
    // Reversed pages are read as a range.
    expect(ranges(interpretChunk(output([paper(9, 1)]), middle))).toEqual([[10, 18]]);
  });

  it("rejects an answer that accounts for fewer than half of the pages (retryable)", () => {
    const err = (() => {
      try {
        interpretChunk(output([paper(1, 2)], [{ page: 3, kind: "blank" }]), middle);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: "invalid_output", o: { retryable: true } });
    expect(() => interpretChunk(output([], [1, 2, 3, 4, 5].map((page) => ({ page, kind: "blank" as const }))), middle)).not.toThrow();
  });

  it("always makes progress", () => {
    for (const papers of [[paper(1, 9, { may_continue_after_chunk: true })], [paper(1, 1), paper(2, 9, { may_continue_after_chunk: true })]]) {
      expect(interpretChunk(output(papers), middle).nextPage).toBeGreaterThan(middle.firstPage);
    }
  });
});

describe("splitUsage", () => {
  it("shares a call's usage so the parts add up to it", () => {
    const shares = splitUsage({ inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 }, 3);
    expect(shares).toEqual([
      { inputTokens: 4, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 },
      { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
      { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
    ]);
    expect(splitUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 }, 0)).toEqual([]);
  });
});

describe("hasOnePassProgress", () => {
  it("is true once a chunk was answered or finished", () => {
    const empty = { nextPage: 1, endedCleanly: true, chunks: 0, maxChunkPages: null, papers: [], skipped: [], pending: null };
    expect(hasOnePassProgress(null)).toBe(false);
    expect(hasOnePassProgress(empty)).toBe(false);
    expect(hasOnePassProgress({ ...empty, maxChunkPages: 9 })).toBe(false);
    expect(hasOnePassProgress({ ...empty, chunks: 1, nextPage: 19 })).toBe(true);
  });
});
