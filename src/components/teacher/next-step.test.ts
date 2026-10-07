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

describe("nextStep", () => {
  it("sends the teacher to the key until it is approved", () => {
    expect(nextStep(card({ keyStatus: "empty", keyApproved: false }))).toMatchObject({ text: "Add the answer key", href: "/teacher/assignments/a1/key" });
    expect(nextStep(card({ keyStatus: "processing", keyApproved: false }))?.tone).toBe("info");
    expect(nextStep(card({ keyStatus: "failed", keyApproved: false }))?.tone).toBe("danger");
    expect(nextStep(card({ keyApproved: false }))).toMatchObject({ text: "Check and approve the answer key", tone: "warning" });
  });

  it("puts papers to review before failed papers", () => {
    expect(nextStep(card({ counts: counts({ needs_review: 3, failed: 1 }) }))).toEqual({
      text: "3 papers to review", href: "/teacher/assignments/a1?filter=needs_review", tone: "warning",
    });
    expect(nextStep(card({ counts: counts({ failed: 1 }) }))).toEqual({
      text: "1 paper failed to grade", href: "/teacher/assignments/a1?filter=failed", tone: "danger",
    });
  });

  it("suggests opening a draft with an approved key", () => {
    expect(nextStep(card({ status: "draft" }))).toMatchObject({ text: "Open it for students", href: "/teacher/assignments/a1" });
  });

  it("asks to release feedback once every paper is graded and checked", () => {
    expect(nextStep(card())).toEqual({ text: "Release feedback on 4 graded papers", href: "/teacher/assignments/a1", tone: "info" });
    expect(nextStep(card({ status: "closed", counts: counts({ graded: 1, total: 1 }) }))?.text).toBe("Release feedback on 1 graded paper");
  });

  it("does not ask to release before papers are done, or once released", () => {
    expect(nextStep(card({ counts: counts({ needs_review: 1 }) }))?.text).toBe("1 paper to review");
    expect(nextStep(card({ counts: counts({ failed: 1 }) }))?.text).toBe("1 paper failed to grade");
    expect(nextStep(card({ counts: counts({ queued: 2 }) }))).toBeNull();
    expect(nextStep(card({ counts: counts({ grading: 1 }) }))).toBeNull();
    expect(nextStep(card({ counts: counts({ graded: 0, total: 0 }) }))).toBeNull();
  });

  it("is quiet once feedback is released and nothing is pending", () => {
    expect(nextStep(card({ released: true }))).toBeNull();
    expect(nextStep(card({ released: true, status: "closed" }))).toBeNull();
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
