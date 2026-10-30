import { describe, expect, it } from "vitest";
import { gradedUnder, gradingScopeFromText } from "./grading-scope";

const KEY = ["1", "2", "3a", "3b", "3c", "4", "5"];

describe("gradingScopeFromText", () => {
  it.each([
    ["Only grade 2, 3b and 5.", ["2", "3b", "5"]],
    ["Grade only questions 1-2", ["1", "2"]],
    ["just grade Q4 and Q5", ["4", "5"]],
    ["Only grade question 3 parts b and c", ["3b", "3c"]],
    ["only grade 3(a) through 3(b)", ["3a", "3b"]],
    ["Only grade 3", ["3a", "3b", "3c"]],
  ])("reads %j as grading only %j", (text, labels) => {
    expect(gradingScopeFromText(text, KEY)).toEqual({ mode: "only", labels, unknown: [] });
  });

  it.each([
    ["Skip question 1.", ["1"]],
    ["Don't grade 3a or 3c, they were extra credit", ["3a", "3c"]],
    ["Please ignore #5", ["5"]],
  ])("reads %j as skipping %j", (text, labels) => {
    expect(gradingScopeFromText(text, KEY)).toMatchObject({ mode: "skip", labels });
  });

  it("finds the scope in a longer note, and reports names the key doesn't have", () => {
    expect(gradingScopeFromText("Units are required. Only grade 2, 4 and 7; accept synonyms.", KEY))
      .toEqual({ mode: "only", labels: ["2", "4"], unknown: ["7"] });
  });

  it("ignores instructions that don't say which questions to grade", () => {
    expect(gradingScopeFromText("Units are required on word problems. Accept any reasonable synonym.", KEY)).toBeNull();
    expect(gradingScopeFromText("Be lenient with spelling in 2 answers", KEY)).toBeNull();
    expect(gradingScopeFromText("Only grade the ones they attempted", KEY)).toBeNull();
  });
});

describe("gradedUnder", () => {
  it("counts the named ones for 'only', and the rest for 'skip'", () => {
    expect([...gradedUnder({ mode: "only", labels: ["2", "5"], unknown: [] }, KEY)]).toEqual(["2", "5"]);
    expect([...gradedUnder({ mode: "skip", labels: ["1"], unknown: [] }, KEY)]).toEqual(["2", "3a", "3b", "3c", "4", "5"]);
  });
});
