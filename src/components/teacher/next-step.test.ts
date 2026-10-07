import { describe, expect, it } from "vitest";
import type { DashboardView } from "@/lib/types";
import { nextStep } from "./next-step";
import { plural } from "./text";

type Card = DashboardView["assignments"][number];

function card(o: Partial<Card> = {}): Card {
  return {
    id: "a1", title: "Quiz", status: "open", shareCode: "K7M4QX", keyStatus: "ready", keyApproved: true,
    counts: { queued: 0, grading: 0, graded: 4, needs_review: 0, failed: 0, total: 4 }, released: false, createdAt: 0, ...o,
  };
}

const counts = (o: Partial<Card["counts"]>): Card["counts"] => ({ ...card().counts, ...o });

const ON = { studentsCanUpload: true };
const OFF = { studentsCanUpload: false };

describe("nextStep", () => {
  it("sends the teacher to the key until it is approved", () => {
    expect(nextStep(card({ keyStatus: "empty", keyApproved: false }), ON)).toMatchObject({ text: "Add the answer key", href: "/teacher/assignments/a1/key" });
    expect(nextStep(card({ keyStatus: "processing", keyApproved: false }), ON)?.tone).toBe("info");
    expect(nextStep(card({ keyStatus: "failed", keyApproved: false }), ON)?.tone).toBe("danger");
    expect(nextStep(card({ keyApproved: false }), ON)).toMatchObject({ text: "Check and approve the answer key", tone: "warning" });
  });

  it("puts papers to review before failed papers", () => {
    expect(nextStep(card({ counts: counts({ needs_review: 3, failed: 1 }) }), ON)).toEqual({
      text: "3 papers to review", href: "/teacher/assignments/a1?filter=needs_review", tone: "warning",
    });
    expect(nextStep(card({ counts: counts({ failed: 1 }) }), ON)).toEqual({
      text: "1 paper failed to grade", href: "/teacher/assignments/a1?filter=failed", tone: "danger",
    });
  });

  it("suggests opening a draft with an approved key", () => {
    expect(nextStep(card({ status: "draft" }), ON)).toMatchObject({ text: "Open it for students", href: "/teacher/assignments/a1" });
  });

  it("asks to release feedback once every paper is graded and checked", () => {
    expect(nextStep(card(), ON)).toEqual({ text: "Release feedback on 4 graded papers", href: "/teacher/assignments/a1", tone: "info" });
    expect(nextStep(card({ status: "closed", counts: counts({ graded: 1, total: 1 }) }), ON)?.text).toBe("Release feedback on 1 graded paper");
  });

  it("does not ask to release before papers are done, or once released", () => {
    expect(nextStep(card({ counts: counts({ needs_review: 1 }) }), ON)?.text).toBe("1 paper to review");
    expect(nextStep(card({ counts: counts({ failed: 1 }) }), ON)?.text).toBe("1 paper failed to grade");
    expect(nextStep(card({ counts: counts({ queued: 2 }) }), ON)).toBeNull();
    expect(nextStep(card({ counts: counts({ grading: 1 }) }), ON)).toBeNull();
    expect(nextStep(card({ counts: counts({ graded: 0, total: 0 }) }), ON)).toBeNull();
  });

  it("is quiet once feedback is released and nothing is pending", () => {
    expect(nextStep(card({ released: true }), ON)).toBeNull();
    expect(nextStep(card({ released: true, status: "closed" }), ON)).toBeNull();
  });
});

describe("nextStep while students can't upload", () => {
  it("keeps the answer-key steps", () => {
    expect(nextStep(card({ keyStatus: "empty", keyApproved: false, counts: counts({ graded: 0, total: 0 }) }), OFF)).toMatchObject({
      text: "Add the answer key", href: "/teacher/assignments/a1/key",
    });
    expect(nextStep(card({ keyApproved: false }), OFF)?.text).toBe("Check and approve the answer key");
  });

  it("asks the teacher to upload the homework once the key is approved and there are no papers", () => {
    const empty = counts({ graded: 0, total: 0 });
    expect(nextStep(card({ status: "draft", counts: empty }), OFF)).toEqual({
      text: "Upload homework", href: "/teacher/assignments/a1/upload", tone: "info",
    });
    expect(nextStep(card({ status: "open", counts: empty }), OFF)?.text).toBe("Upload homework");
  });

  it("keeps the review and failure steps", () => {
    expect(nextStep(card({ counts: counts({ needs_review: 2, failed: 1 }) }), OFF)?.text).toBe("2 papers to review");
    expect(nextStep(card({ counts: counts({ failed: 1 }) }), OFF)?.text).toBe("1 paper failed to grade");
  });

  it("never suggests opening the assignment or releasing feedback", () => {
    expect(nextStep(card({ status: "draft" }), OFF)).toBeNull();
    expect(nextStep(card(), OFF)).toBeNull();
    expect(nextStep(card({ status: "closed", counts: counts({ graded: 1, total: 1 }) }), OFF)).toBeNull();
    expect(nextStep(card({ counts: counts({ graded: 0, queued: 2, total: 2 }) }), OFF)).toBeNull();
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
