import { describe, expect, it } from "vitest";
import { boardOrderIds, nextNeedsReview, organizeBoard, type BoardGroup } from "@/lib/grading/board";
import { nameKey, nameSortKey } from "@/lib/grading/names";
import { makeSection, makeSubmission } from "@/lib/grading/test-utils";
import type { Section, Submission } from "@/lib/types";

function paper(id: string, name: string | null, o: Partial<Submission> = {}): Submission {
  return makeSubmission({ id, studentName: name, nameKey: nameKey(name), nameSortKey: nameSortKey(name), ...o });
}

function shape(groups: BoardGroup[]) {
  return groups.map((group) => ({
    key: group.key,
    label: group.label,
    rows: group.rows.map((row) => [row.current.id, ...row.earlier.map((s) => s.id)].join("<")),
  }));
}

const period3 = makeSection({ label: "Period 3", canonicalKey: "3", sortOrder: 1 });
const period1 = makeSection({ label: "Period 1", canonicalKey: "1", sortOrder: 0 });
const emptySection = makeSection({ label: "Period 5", canonicalKey: "5", sortOrder: 2 });
const SECTIONS: Section[] = [period3, emptySection, period1];

describe("organizeBoard with configured sections", () => {
  const papers = [
    paper("young", "Zoe Young", { sectionId: period1.id, createdAt: 1 }),
    paper("abbott", "Adam Abbott", { sectionId: period1.id, createdAt: 2 }),
    paper("unnamed-1", null, { sectionId: period1.id, createdAt: 3 }),
    paper("lopez", "Maria Lopez", { sectionId: period3.id, createdAt: 4 }),
    paper("nobody", "Ann Nobody", { sectionId: null, sectionKey: "9", createdAt: 5 }),
    paper("stray", "Sam Stray", { sectionId: "deleted-section", createdAt: 6 }),
  ];

  it("orders groups by sort_order, drops empty groups and puts No section last", () => {
    expect(shape(organizeBoard(papers, SECTIONS))).toEqual([
      { key: period1.id, label: "Period 1", rows: ["abbott", "young", "unnamed-1"] },
      { key: period3.id, label: "Period 3", rows: ["lopez"] },
      { key: "none", label: "No section", rows: ["nobody", "stray"] },
    ]);
  });

  it("is independent of input order", () => {
    expect(shape(organizeBoard([...papers].reverse(), SECTIONS))).toEqual(shape(organizeBoard(papers, SECTIONS)));
  });

  it("sorts by surname, then submission time, with unnamed papers last", () => {
    const rows = organizeBoard([
      paper("unnamed-early", null, { sectionId: period1.id, createdAt: 1 }),
      paper("lopez-late", "Maria Lopez", { sectionId: period1.id, createdAt: 9 }),
      paper("lopez-other", "Ana Lopez", { sectionId: period1.id, createdAt: 8 }),
      paper("adams", "Zed Adams", { sectionId: period1.id, createdAt: 10 }),
      paper("unnamed-late", null, { sectionId: period1.id, createdAt: 2 }),
      paper("oslo", "Øyvind Oslo", { sectionId: period1.id, createdAt: 3 }),
    ], SECTIONS);
    expect(boardOrderIds(rows)).toEqual(["adams", "lopez-other", "lopez-late", "oslo", "unnamed-early", "unnamed-late"]);
  });
});

describe("organizeBoard resubmissions", () => {
  it("collapses a student's attempts in one section under the newest, earlier ones newest first", () => {
    const groups = organizeBoard([
      paper("first", "Maria Lopez", { sectionId: period1.id, createdAt: 1 }),
      paper("third", "maría lopez", { sectionId: period1.id, createdAt: 3 }),
      paper("second", "Lopez, Maria", { sectionId: period1.id, createdAt: 2 }),
      paper("other-section", "Maria Lopez", { sectionId: period3.id, createdAt: 4 }),
      paper("unnamed-a", null, { sectionId: period1.id, createdAt: 5 }),
      paper("unnamed-b", null, { sectionId: period1.id, createdAt: 6 }),
    ], SECTIONS);
    expect(shape(groups)).toEqual([
      { key: period1.id, label: "Period 1", rows: ["third<second<first", "unnamed-a", "unnamed-b"] },
      { key: period3.id, label: "Period 3", rows: ["other-section"] },
    ]);
    expect(boardOrderIds(groups)).toEqual(["third", "unnamed-a", "unnamed-b", "other-section"]);
  });

  it("does not merge unsectioned papers whose written sections differ", () => {
    const groups = organizeBoard([
      paper("a", "Maria Lopez", { sectionKey: "9", createdAt: 1 }),
      paper("b", "Maria Lopez", { sectionKey: "8", createdAt: 2 }),
      paper("c", "Maria Lopez", { sectionKey: null, createdAt: 3 }),
    ], SECTIONS);
    expect(shape(groups)).toEqual([{ key: "none", label: "No section", rows: ["a", "b", "c"] }]);
  });
});

describe("organizeBoard without configured sections", () => {
  it("groups by what students wrote, in numeric order, labelled with the most common spelling", () => {
    const groups = organizeBoard([
      paper("p10", "Ann Ten", { sectionKey: "10", aiSectionRaw: "Period 10", createdAt: 1 }),
      paper("p2-a", "Bea Two", { sectionKey: "2", aiSectionRaw: "P2", createdAt: 2 }),
      paper("p2-b", "Cal Two", { sectionKey: "2", aiSectionRaw: "Period 2", createdAt: 3 }),
      paper("p2-c", "Dee Two", { sectionKey: "2", aiSectionRaw: "Period 2", createdAt: 4 }),
      paper("none", "Eve None", { sectionKey: null, createdAt: 5 }),
      paper("b", "Fay Bee", { sectionKey: "b", aiSectionRaw: "Block B", createdAt: 6 }),
    ], []);
    expect(shape(groups)).toEqual([
      { key: "k:2", label: "Period 2", rows: ["p2-a", "p2-b", "p2-c"] },
      { key: "k:10", label: "Period 10", rows: ["p10"] },
      { key: "k:b", label: "Block B", rows: ["b"] },
      { key: "none", label: "No section", rows: ["none"] },
    ]);
  });

  it("collapses resubmissions within a written section", () => {
    const groups = organizeBoard([
      paper("old", "Maria Lopez", { sectionKey: "3", aiSectionRaw: "P3", createdAt: 1 }),
      paper("new", "Maria Lopez", { sectionKey: "3", aiSectionRaw: "Per 3", createdAt: 2 }),
    ], []);
    expect(shape(groups)).toEqual([{ key: "k:3", label: "Per 3", rows: ["new<old"] }]);
  });

  it("is empty without submissions", () => {
    expect(organizeBoard([], [])).toEqual([]);
    expect(organizeBoard([], SECTIONS)).toEqual([]);
  });
});

describe("nextNeedsReview", () => {
  const groups = organizeBoard([
    paper("a", "Amy A", { sectionId: period1.id, status: "needs_review" }),
    paper("b", "Ben B", { sectionId: period1.id, status: "graded" }),
    paper("c", "Cat C", { sectionId: period1.id, status: "needs_review" }),
    paper("d-old", "Dan D", { sectionId: period3.id, status: "needs_review", createdAt: 1 }),
    paper("d", "Dan D", { sectionId: period3.id, status: "graded", createdAt: 2 }),
  ], SECTIONS);

  it("finds the next current paper that needs review", () => {
    expect(nextNeedsReview(groups, "a")).toBe("c");
    expect(nextNeedsReview(groups, "b")).toBe("c");
  });

  it("wraps around to the start and skips earlier attempts", () => {
    expect(nextNeedsReview(groups, "c")).toBe("a");
    expect(nextNeedsReview(groups, "d")).toBe("a");
    expect(nextNeedsReview(groups, "d-old")).toBe("a");
  });

  it("never returns the paper itself", () => {
    const single = organizeBoard([paper("only", "Amy A", { sectionId: period1.id, status: "needs_review" })], SECTIONS);
    expect(nextNeedsReview(single, "only")).toBeNull();
  });

  it("starts from the top for an unknown id and is null when nothing needs review", () => {
    expect(nextNeedsReview(groups, "gone")).toBe("a");
    expect(nextNeedsReview(organizeBoard([paper("x", "X", { status: "graded" })], []), "x")).toBeNull();
    expect(nextNeedsReview([], "x")).toBeNull();
  });
});
