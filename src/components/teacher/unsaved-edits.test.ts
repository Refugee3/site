import { describe, expect, it } from "vitest";
import { describeUnsaved, leaveUnsavedMessage, listInWords, orderUnsaved, withUnsaved } from "./unsaved-edits";

describe("listInWords", () => {
  it("joins with commas and a final 'and'", () => {
    expect(listInWords([])).toBe("");
    expect(listInWords(["Question 3"])).toBe("Question 3");
    expect(listInWords(["Student name", "Question 3"])).toBe("Student name and Question 3");
    expect(listInWords(["Student name", "Question 3", "Overall feedback"])).toBe("Student name, Question 3 and Overall feedback");
  });
});

describe("withUnsaved", () => {
  it("adds, relabels and removes a form", () => {
    const empty: ReadonlyMap<string, string> = new Map();
    const one = withUnsaved(empty, "item:1", "Question 1");
    expect([...one]).toEqual([["item:1", "Question 1"]]);
    expect(empty.size).toBe(0);
    expect([...withUnsaved(one, "item:1", "Question 1a")]).toEqual([["item:1", "Question 1a"]]);
    expect(withUnsaved(one, "item:1", null).size).toBe(0);
  });

  it("returns the same map when nothing changes", () => {
    const one: ReadonlyMap<string, string> = new Map([["identity", "Student name"]]);
    expect(withUnsaved(one, "identity", "Student name")).toBe(one);
    expect(withUnsaved(one, "total", null)).toBe(one);
  });
});

describe("orderUnsaved", () => {
  it("lists the forms in page order, unknown ones last in the order they were edited", () => {
    const unsaved = new Map([
      ["item:q3", "Question 3"],
      ["other", "Something else"],
      ["identity", "Student name/section"],
      ["item:q1", "Question 1"],
    ]);
    expect(orderUnsaved(unsaved, ["identity", "total", "overall", "item:q1", "item:q2", "item:q3"])).toEqual([
      "Student name/section", "Question 1", "Question 3", "Something else",
    ]);
  });
});

describe("messages", () => {
  it("names the forms with unsaved edits", () => {
    expect(leaveUnsavedMessage(["Question 3"])).toBe("You have unsaved changes on Question 3. Leave without saving them?");
    expect(describeUnsaved(["Question 3"], "marking this paper reviewed")).toBe(
      "Your changes on Question 3 aren't saved yet. Save it with its own Save button, or undo it, before marking this paper reviewed.",
    );
    expect(describeUnsaved(["Student name", "Total override"], "regrading")).toBe(
      "Your changes on Student name and Total override aren't saved yet. Save them with their own Save button, or undo them, before regrading.",
    );
  });
});
