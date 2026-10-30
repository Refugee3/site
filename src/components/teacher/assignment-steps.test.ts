import { describe, expect, it } from "vitest";
import type { AssignmentHeader } from "@/lib/types";
import { assignmentSteps } from "./assignment-steps";

type Header = Pick<AssignmentHeader, "keyStatus" | "keyApproved" | "counts" | "scans">;

function header(o: Partial<Header> = {}): Header {
  return {
    keyStatus: "ready", keyApproved: true,
    counts: { queued: 0, grading: 0, graded: 4, needs_review: 0, failed: 0, total: 4 },
    scans: { splitting: 0, onePass: 0, review: 0, failed: 0, firstReviewId: null },
    ...o,
  };
}

const counts = (o: Partial<Header["counts"]>): Header["counts"] => ({ ...header().counts, ...o });
const states = (h: Header) => assignmentSteps(h, "a1").map((step) => step.state);
const statuses = (h: Header) => assignmentSteps(h, "a1").map((step) => step.status);

describe("assignmentSteps", () => {
  it("names the three steps and links each to its tab", () => {
    expect(assignmentSteps(header(), "a1").map(({ number, title, href }) => ({ number, title, href }))).toEqual([
      { number: 1, title: "Add the answer key", href: "/teacher/assignments/a1/key" },
      { number: 2, title: "Upload students' work", href: "/teacher/assignments/a1/upload" },
      { number: 3, title: "Review results", href: "/teacher/assignments/a1" },
    ]);
  });

  it("starts at the answer key", () => {
    const fresh = header({ keyStatus: "empty", keyApproved: false, counts: counts({ graded: 0, total: 0 }) });
    expect(states(fresh)).toEqual(["current", "todo", "todo"]);
    expect(statuses(fresh)).toEqual(["Not added yet", "No papers yet", "Nothing to review yet"]);
    expect(statuses(header({ keyStatus: "processing", keyApproved: false }))[0]).toBe("Being read…");
    expect(statuses(header({ keyStatus: "failed", keyApproved: false }))[0]).toBe("Couldn't be read");
    expect(statuses(header({ keyApproved: false }))[0]).toBe("Check and approve it");
  });

  it("moves on to uploading once the key is approved", () => {
    const h = header({ counts: counts({ graded: 0, total: 0 }) });
    expect(states(h)).toEqual(["done", "current", "todo"]);
    expect(statuses(h)).toEqual(["Approved", "No papers yet", "Nothing to review yet"]);
    expect(statuses(header({ counts: counts({ graded: 0, total: 0 }), scans: { ...h.scans, splitting: 1 } }))[1]).toBe("Reading your scan…");
  });

  it("asks for a review while papers are flagged, failed or still being graded", () => {
    expect(states(header({ counts: counts({ needs_review: 2, total: 6 }) }))).toEqual(["done", "done", "current"]);
    expect(statuses(header({ counts: counts({ needs_review: 2, total: 6 }) }))).toEqual(["Approved", "6 papers uploaded", "2 need your check"]);
    expect(statuses(header({ counts: counts({ needs_review: 1, total: 5 }) }))[2]).toBe("1 needs your check");
    expect(statuses(header({ counts: counts({ failed: 1, total: 5 }) }))[2]).toBe("1 couldn't be graded");
    expect(statuses(header({ counts: counts({ queued: 2, grading: 1, total: 7 }) }))[2]).toBe("Grading 3 papers…");
    expect(statuses(header({ scans: { ...header().scans, review: 1 } }))[2]).toBe("Check your scan's split");
  });

  it("ticks every step once every paper is graded and checked", () => {
    expect(states(header())).toEqual(["done", "done", "done"]);
    expect(statuses(header())[2]).toBe("All graded and checked");
  });

  it("keeps a later step done when an earlier one needs the teacher again", () => {
    // Papers were uploaded, then the key was edited and is waiting for approval.
    expect(states(header({ keyApproved: false }))).toEqual(["current", "done", "done"]);
  });
});
