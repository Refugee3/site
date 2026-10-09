import { describe, expect, it } from "vitest";
import { canonicalSectionKey, parseSectionsText, resolveSection, sectionsToText } from "@/lib/grading/sections";
import { makeSection } from "@/lib/grading/test-utils";
import type { Section } from "@/lib/types";

describe("canonicalSectionKey", () => {
  it.each<[string | null | undefined, string | null]>([
    // spellings students write for a section, and the key each must reduce to
    ["Period 3", "3"],
    ["P3", "3"],
    ["3rd period", "3"],
    ["Sec. 003", "3"],
    ["Per III", "3"],
    ["third", "3"],
    ["Block B", "b"],
    ["2B", "2 b"],
    // blanks and filler only
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["Period", null],
    ["Section #", null],
    // fillers, ordinals, number words
    ["Section 002", "2"],
    ["per. 4", "4"],
    ["Pd 5", "5"],
    ["Hour 7", "7"],
    ["Hr 2nd", "2"],
    ["Class #6", "6"],
    ["Room 204", "204"],
    ["No. 9", "9"],
    ["Sect 10", "10"],
    ["Grp. A", "a"],
    ["1st", "1"],
    ["3 RD", "3"],
    ["first period", "1"],
    ["Twelfth", "12"],
    ["Period Eleven", "11"],
    ["p.3", "3"],
    ["Period 0", "0"],
    ["Period 000", "0"],
    // roman numerals only after a filler word
    ["Period IV", "4"],
    ["Blk XI", "11"],
    ["IV", "iv"],
    ["Block I", "1"],
    // spelling noise
    ["  PERIOD   3  ", "3"],
    ["Ｐｅｒｉｏｄ　３", "3"],
    ["Period 3/4", "3 4"],
    ["Section A-1", "a 1"],
    ["AP Bio - Period 2", "ap bio 2"],
    ["(Period 3)", "3"],
    ["Period 3 – Biology", "3 biology"],
    ["Per_6", "6"],
  ])("%j → %j", (raw, key) => {
    expect(canonicalSectionKey(raw)).toBe(key);
  });
});

describe("parseSectionsText", () => {
  it("reads labels, aliases and canonical keys, skipping blank lines", () => {
    const { sections, errors } = parseSectionsText("Period 1 | P1, 1st\n\n  Period 3  \r\nBlock B | B block, B  \n");
    expect(errors).toEqual([]);
    expect(sections).toEqual([
      { label: "Period 1", aliases: ["P1", "1st"], canonicalKey: "1" },
      { label: "Period 3", aliases: [], canonicalKey: "3" },
      { label: "Block B", aliases: ["B block", "B"], canonicalKey: "b" },
    ]);
  });

  it("returns nothing for an empty textarea", () => {
    expect(parseSectionsText("  \n \n")).toEqual({ sections: [], errors: [] });
  });

  it("rejects two lines that are the same section and suggests an alias", () => {
    const { sections, errors } = parseSectionsText("Period 3\nP3");
    expect(sections).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Line 2");
    expect(errors[0]).toContain("put P3 as an alias");
  });

  it("rejects an alias that names another section, naming the alias", () => {
    const { sections, errors } = parseSectionsText("Period 1\nPeriod 2 | P1");
    expect(sections.map((s) => s.label)).toEqual(["Period 1"]);
    expect(errors).toEqual([
      'Line 2: "P1" is the same section as "Period 1" on line 1; put P1 as an alias instead (Period 1 | P1).',
    ]);
  });

  it("rejects a missing label, an unidentifiable spelling and an over-long label", () => {
    const { sections, errors } = parseSectionsText(`| P1\nPeriod\nPeriod 4 | per\n${"x".repeat(61)}\nPeriod 5`);
    expect(sections.map((s) => s.label)).toEqual(["Period 5"]);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/^Line 1: put the section name/);
    expect(errors[1]).toMatch(/^Line 2: "Period" does not identify a section/);
    expect(errors[2]).toMatch(/^Line 3: "per" does not identify a section/);
    expect(errors[3]).toMatch(/^Line 4: .* longer than 60 characters/);
  });

  it("round-trips through sectionsToText in sort order", () => {
    const sections: Section[] = [
      makeSection({ label: "Period 3", canonicalKey: "3", sortOrder: 1 }),
      makeSection({ label: "Period 1", canonicalKey: "1", aliases: ["P1", "1st"], sortOrder: 0 }),
    ];
    const text = sectionsToText(sections);
    expect(text).toBe("Period 1 | P1, 1st\nPeriod 3");
    expect(parseSectionsText(text).sections).toEqual([
      { label: "Period 1", aliases: ["P1", "1st"], canonicalKey: "1" },
      { label: "Period 3", aliases: [], canonicalKey: "3" },
    ]);
  });
});

describe("resolveSection", () => {
  const period1 = makeSection({ label: "Period 1", canonicalKey: "1", aliases: ["P1", "First"], sortOrder: 0 });
  const period3 = makeSection({ label: "Period 3", canonicalKey: "3", sortOrder: 1 });
  const blockB = makeSection({ label: "Block B", canonicalKey: "b", sortOrder: 2 });
  const sections = [period1, period3, blockB];

  it("is unconfigured without sections", () => {
    expect(resolveSection("Period 3", "Period 3", [])).toEqual({ kind: "unconfigured" });
  });

  it("picks the only section whatever was written", () => {
    expect(resolveSection(null, null, [period3])).toEqual({ kind: "only", sectionId: period3.id });
    expect(resolveSection("Period 9", null, [period3])).toEqual({ kind: "only", sectionId: period3.id });
  });

  it("matches a label or alias exactly after canonicalization", () => {
    expect(resolveSection("per. 3", null, sections)).toEqual({ kind: "exact", sectionId: period3.id });
    expect(resolveSection("1st period", null, sections)).toEqual({ kind: "exact", sectionId: period1.id });
    expect(resolveSection("B", null, sections)).toEqual({ kind: "exact", sectionId: blockB.id });
  });

  it("prefers an exact match over the AI's hint", () => {
    expect(resolveSection("P3", "Period 1", sections)).toEqual({ kind: "exact", sectionId: period3.id });
  });

  it("falls back to matching digits", () => {
    expect(resolveSection("Period 3 Biology", null, sections)).toEqual({ kind: "fuzzy", sectionId: period3.id });
    expect(resolveSection("Mr. Lee 1", null, sections)).toEqual({ kind: "fuzzy", sectionId: period1.id });
  });

  it("falls back to the AI's hint when it names a label (case-insensitively)", () => {
    expect(resolveSection("Mr. Lee's class", " period 1 ", sections)).toEqual({ kind: "hint", sectionId: period1.id });
    expect(resolveSection(null, "BLOCK B", sections)).toEqual({ kind: "hint", sectionId: blockB.id });
  });

  it("ignores a hint that is only an alias or no section at all", () => {
    expect(resolveSection(null, "P1", sections)).toEqual({ kind: "none" });
    expect(resolveSection(null, "Period 9", sections)).toEqual({ kind: "none" });
    expect(resolveSection(null, null, sections)).toEqual({ kind: "none" });
  });

  it("does not guess between ambiguous sections", () => {
    const twoA = makeSection({ label: "Period 2A", canonicalKey: "2 a" });
    const twoB = makeSection({ label: "Period 2B", canonicalKey: "2 b" });
    expect(resolveSection("Period 2", null, [twoA, twoB])).toEqual({ kind: "none" });
    expect(resolveSection("Period 2", "Period 2B", [twoA, twoB])).toEqual({ kind: "hint", sectionId: twoB.id });
    expect(resolveSection("2 b", null, [twoA, twoB])).toEqual({ kind: "exact", sectionId: twoB.id });
  });
});
