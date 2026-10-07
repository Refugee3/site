import { describe, expect, it } from "vitest";
import {
  describePapers,
  droppedReason,
  everyNLayout,
  expectedPagesPerPaper,
  formatPageRanges,
  papersFromLayout,
  SCAN_STATUS_LABEL,
  sameLayout,
  toggleDropped,
  toggleStart,
} from "./scan-layout";
import type { ScanLayout, ScanPageReading } from "./types";

const keep = { startsPaper: false, dropped: false };
const start = { startsPaper: true, dropped: false };
const drop = { startsPaper: false, dropped: true };

function reading(o: Partial<ScanPageReading> = {}): ScanPageReading {
  return {
    kind: "student_work", startsNewPaper: false, studentName: null, sectionRaw: null, pageMarker: null, worksheetPage: null,
    confidence: "high", note: "", reported: true, ...o,
  };
}

describe("papersFromLayout", () => {
  it("groups kept pages from each start, starting at the first kept page", () => {
    expect(papersFromLayout([drop, keep, keep, start, drop, keep, start])).toEqual([[2, 3], [4, 6], [7]]);
  });

  it("returns no papers when every page is left out", () => {
    expect(papersFromLayout([drop, drop])).toEqual([]);
    expect(papersFromLayout([])).toEqual([]);
  });
});

describe("everyNLayout", () => {
  it("starts a paper every n pages and leaves nothing out", () => {
    expect(everyNLayout(5, 2)).toEqual([start, keep, start, keep, start]);
    expect(papersFromLayout(everyNLayout(7, 3))).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(everyNLayout(2, 1)).toEqual([start, start]);
  });
});

describe("expectedPagesPerPaper", () => {
  it("is the most common length", () => {
    expect(expectedPagesPerPaper([3, 3, 4, 2, 3], null)).toBe(3);
    expect(expectedPagesPerPaper([3, 3, 4, 2, 3], 2)).toBe(3);
  });

  it("breaks a tie with the key's page count, else with the smallest length", () => {
    expect(expectedPagesPerPaper([2, 2, 3, 3], 3)).toBe(3);
    expect(expectedPagesPerPaper([2, 2, 3, 3], 4)).toBe(2);
    expect(expectedPagesPerPaper([4, 2], null)).toBe(2);
  });

  it("falls back to the key's page count without papers", () => {
    expect(expectedPagesPerPaper([], 3)).toBe(3);
    expect(expectedPagesPerPaper([], null)).toBeNull();
  });
});

describe("describePapers", () => {
  const o = { keyPageCount: 2, maxPagesPerPaper: 3 };

  it("names each paper from its first named page and section", () => {
    const layout: ScanLayout = [start, keep, start, keep];
    const readings = [
      reading({ sectionRaw: "Per. 3" }), reading({ studentName: "ANA RUIZ", sectionRaw: "P4" }),
      reading({ studentName: "Ben Cho" }), reading({ studentName: "ben  cho" }),
    ];
    expect(describePapers(layout, readings, o)).toEqual([
      { index: 1, pages: [1, 2], name: "Ana Ruiz", section: "Per. 3", flags: [] },
      { index: 2, pages: [3, 4], name: "Ben Cho", section: null, flags: [] },
    ]);
  });

  it("flags each problem, in flag order", () => {
    const layout: ScanLayout = [start, keep, start, keep, keep, keep, start, keep, start, keep, start, drop, keep];
    const readings: Array<ScanPageReading | null> = [
      reading({ studentName: "Ana" }), reading({ studentName: "Ana", confidence: "low" }), // low confidence
      reading({ studentName: "Ben" }), reading(), reading(), reading(), // 4 pages: page count, too many
      reading(), reading(), // no name
      reading({ studentName: "Cy" }), reading({ studentName: "Dee" }), // several names
      reading({ studentName: "Eve" }), reading({ kind: "blank" }), null, // unread page
    ];
    const flags = describePapers(layout, readings, o).map((p) => p.flags);
    expect(flags).toEqual([
      ["low_confidence"],
      ["page_count", "too_many_pages"],
      ["no_name"],
      ["several_names"],
      ["unread_pages"],
    ]);
    const placeholder = reading({ confidence: "low", reported: false, studentName: null });
    expect(describePapers([start, keep], [reading({ studentName: "Fay" }), placeholder], o)[0].flags)
      .toEqual(["low_confidence", "unread_pages"]);
  });

  it("uses the most common length, not the key's, for the page-count flag", () => {
    const layout = everyNLayout(9, 3).concat([start, keep]);
    const papers = describePapers(layout, [], { keyPageCount: 2, maxPagesPerPaper: 40 });
    expect(papers.map((p) => p.flags)).toEqual([[], [], [], ["page_count"]]);
  });

  it("raises no reading-based flags for a scan that was never read", () => {
    const papers = describePapers(everyNLayout(4, 2), [], o);
    expect(papers).toEqual([
      { index: 1, pages: [1, 2], name: null, section: null, flags: [] },
      { index: 2, pages: [3, 4], name: null, section: null, flags: [] },
    ]);
  });

  it("does not count a name without letters as a second name", () => {
    const papers = describePapers([start, keep], [reading({ studentName: "Ana" }), reading({ studentName: "123" })], o);
    expect(papers[0].flags).toEqual([]);
  });
});

describe("toggleStart", () => {
  it("flips the start of a kept page and returns a new layout", () => {
    const layout: ScanLayout = [start, keep, keep];
    const toggled = toggleStart(layout, 1);
    expect(toggled).toEqual([start, start, keep]);
    expect(layout).toEqual([start, keep, keep]);
    expect(toggleStart(toggled, 1)).toEqual(layout);
  });

  it("leaves a left-out page alone", () => {
    expect(toggleStart([start, drop], 1)).toEqual([start, drop]);
  });
});

describe("toggleDropped", () => {
  it("leaves a page out and puts it back as a continuation", () => {
    const dropped = toggleDropped([start, keep, keep], 1);
    expect(dropped).toEqual([start, drop, keep]);
    expect(toggleDropped(dropped, 1)).toEqual([start, keep, keep]);
  });

  it("moves a start to the next kept page, so the paper stays", () => {
    const layout: ScanLayout = [start, keep, start, drop, keep, keep];
    expect(papersFromLayout(layout)).toEqual([[1, 2], [3, 5, 6]]);
    const moved = toggleDropped(layout, 2);
    expect(moved).toEqual([start, keep, drop, drop, start, keep]);
    expect(papersFromLayout(moved)).toEqual([[1, 2], [5, 6]]);
  });

  it("drops a start on the last kept page without moving it anywhere", () => {
    expect(toggleDropped([start, start], 1)).toEqual([start, drop]);
  });
});

describe("droppedReason", () => {
  it("names what the AI saw, else the teacher's choice", () => {
    expect(droppedReason(reading({ kind: "blank" }))).toBe("blank");
    expect(droppedReason(reading({ kind: "cover_or_separator" }))).toBe("cover");
    expect(droppedReason(reading({ kind: "answer_key" }))).toBe("answer_key");
    expect(droppedReason(reading())).toBe("teacher");
    expect(droppedReason(reading({ kind: "other" }))).toBe("teacher");
    expect(droppedReason(null)).toBe("teacher");
  });
});

describe("formatPageRanges", () => {
  it("collapses runs into ranges", () => {
    expect(formatPageRanges([1, 2, 3, 5])).toBe("1–3, 5");
    expect(formatPageRanges([4])).toBe("4");
    expect(formatPageRanges([1, 3, 4, 7, 8, 9])).toBe("1, 3–4, 7–9");
    expect(formatPageRanges([])).toBe("");
  });
});

describe("sameLayout", () => {
  it("compares page by page", () => {
    expect(sameLayout([start, keep], [{ ...start }, { ...keep }])).toBe(true);
    expect(sameLayout([start, keep], [start, start])).toBe(false);
    expect(sameLayout([start, keep], [start, drop])).toBe(false);
    expect(sameLayout([start], [start, keep])).toBe(false);
    expect(sameLayout(null, null)).toBe(true);
    expect(sameLayout(null, [start])).toBe(false);
  });
});

describe("SCAN_STATUS_LABEL", () => {
  it("has the upload page's status labels", () => {
    expect(SCAN_STATUS_LABEL).toEqual({
      splitting: "Being split…", review: "Ready to check", creating: "Creating papers…", done: "Papers created",
      failed: "Couldn't be split",
    });
  });
});
