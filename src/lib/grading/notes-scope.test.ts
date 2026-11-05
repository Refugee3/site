import { describe, expect, it } from "vitest";
import { notesMayChangeVerdict } from "./notes-scope";

const q = (label: string, groupLabel = "") => ({ label, groupLabel });

describe("notesMayChangeVerdict", () => {
  it("is false for instructions about points, parts or what to look for", () => {
    const notes = "Question 3 is worth 10 points, split into 4 parts. Units are required. Show your work on 5. Don't grade 6.";
    for (const label of ["1", "3", "3a", "5", "6"]) expect(notesMayChangeVerdict(notes, q(label)), label).toBe(false);
    expect(notesMayChangeVerdict("", q("1"))).toBe(false);
  });

  it("is true only for the questions a widening sentence names", () => {
    const notes = "Q3: accept B or C. On questions 2, 4 and 7 also accept the unsimplified fraction.";
    expect(["1", "2", "3", "4", "5", "7"].map((label) => notesMayChangeVerdict(notes, q(label)))).toEqual([false, true, true, true, false, true]);
    // Without a word like "question" the number isn't taken as a name, so the sentence counts for every question.
    expect(notesMayChangeVerdict("Accept either answer for 3(b).", q("1"))).toBe(true);
    expect(notesMayChangeVerdict("Question 3(b): accept either answer.", q("3b", "3"))).toBe(true);
    expect(notesMayChangeVerdict("Question 3: accept either answer.", q("3b", "3"))).toBe(true);
    expect(notesMayChangeVerdict("4: accept D too", q("4"))).toBe(true);
    expect(notesMayChangeVerdict("Questions 1-3: ignore spelling mistakes", q("2"))).toBe(true);
  });

  it("is true for every question when a widening sentence names none, or the item's label is unknown", () => {
    expect(notesMayChangeVerdict("Ignore spelling mistakes.", q("6"))).toBe(true);
    expect(notesMayChangeVerdict("Give half credit for a close answer.", q("1"))).toBe(true);
    expect(notesMayChangeVerdict("Q3: accept B or C.", {})).toBe(true);
  });
});
