import { describe, expect, it } from "vitest";
import { GROUP_NOTES, groupPages, type MatchedPage, scanPagesOf } from "./group";

/** Scan pages from a list of matched blank pages: a number, null (matched nothing, has ink), "blank", or "1?" (page 1, no name). */
function scan(...matches: Array<number | null | "blank" | "1?" | "2~">): MatchedPage[] {
  return matches.map((m, i) => ({
    page: i + 1,
    blankPage: m === "blank" || m === null ? null : m === "1?" ? 1 : m === "2~" ? 2 : m,
    ambiguous: m === "2~",
    blank: m === "blank",
    nameInk: m === 1 ? true : m === "1?" ? false : null,
  }));
}

const papersOf = (pages: MatchedPage[], k: number) => groupPages(pages, k).papers.map(scanPagesOf);

describe("grouping scan pages into papers (fast lane)", () => {
  it("a clean stack: a paper starts at every page 1", () => {
    const g = groupPages(scan(1, 2, 3, 1, 2, 3, 1, 2, 3), 3);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(g.papers.every((p) => p.notes.length === 0 && p.missing.length === 0)).toBe(true);
    expect(g.skipped).toEqual([]);
    expect(g.matchedShare).toBe(1);
  });

  it("two consecutive students on a 2-page worksheet are never merged, even without a name on the second", () => {
    expect(papersOf(scan(1, 2, 1, 2), 2)).toEqual([[1, 2], [3, 4]]);
    const g = groupPages(scan(1, 2, "1?", 2), 2);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 2], [3, 4]]);
    expect(g.papers[0].notes).toEqual([]);
    expect(g.papers[1].notes).toEqual([GROUP_NOTES.noName(3)]);
  });

  it("two page 1s in a row are two papers: the first one's page 2 is missing", () => {
    const g = groupPages(scan(1, 1, 2), 2);
    expect(g.papers.map(scanPagesOf)).toEqual([[1], [2, 3]]);
    expect(g.papers[0]).toMatchObject({ missing: [2], notes: [GROUP_NOTES.missing([2])] });
    expect(g.papers[1].notes).toEqual([]);
  });

  it("extra blank pages (blank backs) are skipped and reported, without flagging anyone", () => {
    const g = groupPages(scan(1, "blank", 2, "blank", 1, "blank", 2, "blank"), 2);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 3], [5, 7]]);
    expect(g.papers.every((p) => p.notes.length === 0)).toBe(true);
    expect(g.skipped).toEqual([2, 4, 6, 8].map((page) => ({ page, reason: "blank" })));
    expect(g.matchedShare).toBe(1);
  });

  it("a cover page that matches no worksheet page is skipped", () => {
    const g = groupPages(scan(null, 1, 2, 3, 1, 2, 3), 3);
    expect(g.papers.map(scanPagesOf)).toEqual([[2, 3, 4], [5, 6, 7]]);
    expect(g.skipped).toEqual([{ page: 1, reason: "other" }]);
    expect(g.papers.every((p) => p.notes.length === 0)).toBe(true);
  });

  it("a missing page: the paper is kept with what is there, and flagged", () => {
    const g = groupPages(scan(1, 2, 3, 1, 3, 1, 2, 3), 3);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 2, 3], [4, 5], [6, 7, 8]]);
    expect(g.papers[1]).toMatchObject({ missing: [2], notes: [GROUP_NOTES.missing([2])] });
    expect(g.papers[0].notes).toEqual([]);
    expect(g.papers[2].notes).toEqual([]);
  });

  it("a student whose page 2 is missing, on a 2-page worksheet, next to a page that matched nothing", () => {
    const g = groupPages(scan(1, 2, 1, null, 1, 2), 2);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 2], [3], [5, 6]]);
    expect(g.papers[1].missing).toEqual([2]);
    expect(g.papers[1].notes).toEqual([GROUP_NOTES.missing([2]), GROUP_NOTES.unmatchedNearby([4])]);
    expect(g.skipped).toEqual([{ page: 4, reason: "other" }]);
  });

  it("reordered pages are put in worksheet order and flagged", () => {
    const g = groupPages(scan(1, 3, 2, 1, 2, 3), 3);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 3, 2], [4, 5, 6]]);
    expect(g.papers[0].pages.map((p) => p.blankPage)).toEqual([1, 2, 3]);
    expect(g.papers[0].notes).toEqual([GROUP_NOTES.outOfOrder(3, 2)]);
    expect(g.papers[1].notes).toEqual([]);
  });

  it("a repeated page starts another paper, and both are flagged", () => {
    const g = groupPages(scan(1, 2, 2, 3), 3);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 2], [3, 4]]);
    expect(g.papers[0].notes).toContain(GROUP_NOTES.repeated(3, 2));
    expect(g.papers[1].notes).toContain(GROUP_NOTES.noFirstPage(3, 2));
    expect(g.papers[1].missing).toEqual([1]);
  });

  it("a scan that starts mid-paper, and an ambiguous match, are flagged", () => {
    const g = groupPages(scan(2, 3, 1, "2~", 3), 3);
    expect(g.papers.map(scanPagesOf)).toEqual([[1, 2], [3, 4, 5]]);
    expect(g.papers[0].notes[0]).toBe(GROUP_NOTES.noFirstPage(1, 2));
    expect(g.papers[1].notes).toEqual([GROUP_NOTES.ambiguous(4)]);
  });

  it("a one-page worksheet: every matched page is a paper", () => {
    expect(papersOf(scan(1, 1, "blank", 1), 1)).toEqual([[1], [2], [4]]);
  });

  it("measures how much of the scan matched the worksheet (for the fallback)", () => {
    expect(groupPages(scan(null, null, null, 1, "blank"), 2).matchedShare).toBe(0.25);
    expect(groupPages(scan("blank"), 2).matchedShare).toBe(1);
  });
});
