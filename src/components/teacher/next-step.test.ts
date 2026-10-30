import { describe, expect, it } from "vitest";
import type { DashboardView } from "@/lib/types";
import { nextStep } from "./next-step";
import { plural } from "./text";

type Card = DashboardView["assignments"][number];

function card(o: Partial<Card> = {}): Card {
  return {
    id: "a1", title: "Quiz", kind: "homework", keyStatus: "ready", keyApproved: true,
    counts: { queued: 0, grading: 0, graded: 4, needs_review: 0, failed: 0, total: 4 },
    scans: { splitting: 0, onePass: 0, review: 0, failed: 0, firstReviewId: null }, createdAt: 0, progress: null, ...o,
  };
}

const counts = (o: Partial<Card["counts"]>): Card["counts"] => ({ ...card().counts, ...o });
const scans = (o: Partial<Card["scans"]>): Card["scans"] => ({ ...card().scans, ...o });
const empty = counts({ graded: 0, total: 0 });

describe("nextStep", () => {
  it("sends the teacher to the key until it is approved", () => {
    expect(nextStep(card({ keyStatus: "empty", keyApproved: false, counts: empty }))).toEqual({
      text: "Next: add the answer key", href: "/teacher/assignments/a1/key", tone: "info",
    });
    expect(nextStep(card({ keyStatus: "processing", keyApproved: false }))).toMatchObject({ text: "Reading your answer key…", tone: "info" });
    expect(nextStep(card({ keyStatus: "failed", keyApproved: false }))?.tone).toBe("danger");
    expect(nextStep(card({ keyApproved: false }))).toMatchObject({ text: "Next: check and approve the answer key", tone: "warning" });
  });

  it("asks for the students' work once the key is approved and there are no papers", () => {
    expect(nextStep(card({ counts: empty }))).toEqual({
      text: "Next: upload the students' homework", href: "/teacher/assignments/a1/upload", tone: "info",
    });
    expect(nextStep(card({ kind: "quiz", counts: empty })).text).toBe("Next: upload the students' quizzes");
  });

  it("puts flagged papers before papers that couldn't be graded", () => {
    expect(nextStep(card({ counts: counts({ needs_review: 3, failed: 1 }) }))).toEqual({
      text: "Next: check 3 papers the AI flagged", href: "/teacher/assignments/a1?filter=needs_review", tone: "warning",
    });
    expect(nextStep(card({ counts: counts({ needs_review: 1 }) })).text).toBe("Next: check 1 paper the AI flagged");
    expect(nextStep(card({ counts: counts({ failed: 1 }) }))).toEqual({
      text: "1 paper couldn't be graded — retry or grade by hand", href: "/teacher/assignments/a1?filter=failed", tone: "danger",
    });
  });

  it("says papers are being graded, then that everything is done", () => {
    expect(nextStep(card({ counts: counts({ queued: 2 }) }))).toEqual({ text: "Grading papers…", href: "/teacher/assignments/a1", tone: "info" });
    expect(nextStep(card({ counts: counts({ grading: 1 }) })).text).toBe("Grading papers…");
    expect(nextStep(card())).toEqual({
      text: "All papers graded and checked — see the results", href: "/teacher/assignments/a1", tone: "success",
    });
  });
});

describe("nextStep with a scan of the class's papers", () => {
  it("asks to check a split scan before the remaining steps", () => {
    expect(nextStep(card({ counts: empty, scans: scans({ review: 1, firstReviewId: "s1" }) }))).toEqual({
      text: "Next: check how your scan was split", href: "/teacher/assignments/a1/scans/s1", tone: "warning",
    });
    // With papers already there (an earlier scan), and with several scans, which the upload tab lists.
    expect(nextStep(card({ scans: scans({ review: 2, failed: 1, firstReviewId: "s1" }) }))).toEqual({
      text: "Next: check how 2 scans were split", href: "/teacher/assignments/a1/upload", tone: "warning",
    });
  });

  it("points to a scan that couldn't be split", () => {
    expect(nextStep(card({ counts: empty, scans: scans({ failed: 1 }) }))).toEqual({
      text: "A scan couldn't be split", href: "/teacher/assignments/a1/upload", tone: "danger",
    });
    expect(nextStep(card({ scans: scans({ failed: 2 }) })).text).toBe("2 scans couldn't be split");
  });

  it("says a scan is being read only while there are no papers yet", () => {
    expect(nextStep(card({ counts: empty, scans: scans({ splitting: 1 }) }))).toEqual({
      text: "Finding each student's paper in your scan…", href: "/teacher/assignments/a1/upload", tone: "info",
    });
    expect(nextStep(card({ scans: scans({ splitting: 1 }) })).text).toBe("All papers graded and checked — see the results");
    // A scan graded in one pass has no split to wait for.
    expect(nextStep(card({ counts: empty, scans: scans({ splitting: 1, onePass: 1 }) })).text).toBe("Grading your scan…");
    expect(nextStep(card({ counts: empty, scans: scans({ splitting: 2, onePass: 1 }) })).text).toBe("Finding each student's paper in your scan…");
  });

  it("keeps the key and paper steps first", () => {
    expect(nextStep(card({ keyApproved: false, scans: scans({ review: 1 }) })).text).toBe("Next: check and approve the answer key");
    expect(nextStep(card({ counts: counts({ needs_review: 1 }), scans: scans({ review: 1 }) })).text).toBe("Next: check 1 paper the AI flagged");
    expect(nextStep(card({ counts: counts({ failed: 1 }), scans: scans({ review: 1 }) })).text).toBe(
      "1 paper couldn't be graded — retry or grade by hand",
    );
  });
});

describe("plural", () => {
  it("picks the singular only for exactly one", () => {
    expect(plural(0, "paper")).toBe("0 papers");
    expect(plural(1, "paper")).toBe("1 paper");
    expect(plural(2, "attempt")).toBe("2 attempts");
    expect(plural(2, "copy", "copies")).toBe("2 copies");
  });
});
