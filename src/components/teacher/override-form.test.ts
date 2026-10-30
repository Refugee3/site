import { describe, expect, it } from "vitest";
import type { ReviewItemView } from "@/lib/types";
import { lessonStatusText, overrideFormState, overrideRequest, overrideText, type OverrideContext, type OverrideTexts } from "./override-form";

const AI = { feedback: "Nice work.", note: "You solved it." };

function ctx(o: Partial<OverrideContext> = {}): OverrideContext {
  return {
    stored: { points: "", feedback: AI.feedback, note: AI.note, reason: "" },
    aiFeedback: AI.feedback,
    aiNote: AI.note,
    hasOverride: false,
    learnable: true,
    ...o,
  };
}

const untouched: OverrideTexts = { points: "", feedback: AI.feedback, note: AI.note, reason: "" };

describe("overrideText", () => {
  it("is null for the AI's text (trimmed), else the trimmed text", () => {
    expect(overrideText(" Nice work. ", AI.feedback)).toBeNull();
    expect(overrideText(" Units missing. ", AI.feedback)).toBe("Units missing.");
    expect(overrideText("", AI.feedback)).toBe("");
  });
});

describe("overrideFormState", () => {
  it("is clean as stored", () => {
    expect(overrideFormState(untouched, ctx())).toEqual({ correcting: false, reasonLive: false, dirty: false });
  });

  it("ignores a reason typed while there is no correction, so the form never stays unsaved", () => {
    // Points typed (the field opens), a reason written, then the points deleted again.
    expect(overrideFormState({ ...untouched, points: "3", reason: "Units optional" }, ctx())).toEqual({
      correcting: true, reasonLive: true, dirty: true,
    });
    expect(overrideFormState({ ...untouched, reason: "Units optional" }, ctx())).toEqual({
      correcting: false, reasonLive: false, dirty: false,
    });
  });

  it("counts a reason edit with a stored or typed correction", () => {
    expect(overrideFormState({ ...untouched, points: "1", reason: "Why" }, ctx({ stored: { ...ctx().stored, points: "1" }, hasOverride: true })))
      .toMatchObject({ reasonLive: true, dirty: true });
    expect(overrideFormState({ ...untouched, feedback: "Units missing.", reason: "Why" }, ctx())).toMatchObject({ reasonLive: true, dirty: true });
  });

  it("keeps the reason closed when the AI never read the answer", () => {
    expect(overrideFormState({ ...untouched, points: "1", reason: "Why" }, ctx({ learnable: false }))).toEqual({
      correcting: true, reasonLive: false, dirty: true,
    });
    expect(overrideFormState({ ...untouched, reason: "Why" }, ctx({ learnable: false })).dirty).toBe(false);
  });
});

describe("overrideRequest", () => {
  it("sends a changed reason with a correction", () => {
    expect(overrideRequest({ ...untouched, points: "1.5", reason: "Units optional" }, 150, ctx())).toEqual({
      pointsCenti: 150, feedback: null, whatStudentDid: null, reason: "Units optional",
    });
    expect(overrideRequest({ ...untouched, note: "", reason: "x" }, null, ctx())).toEqual({
      pointsCenti: null, feedback: null, whatStudentDid: "", reason: "x",
    });
  });

  it("omits the reason when it is unchanged, when the save leaves no correction, or when the AI never read the answer", () => {
    const stored = { ...ctx().stored, points: "1", reason: "Kept" };
    expect(overrideRequest({ ...untouched, points: "2", reason: "Kept" }, 200, ctx({ stored, hasOverride: true }))).not.toHaveProperty("reason");
    // Clearing the only override with a reason typed: the reason would be dropped with the lesson anyway.
    expect(overrideRequest({ ...untouched, reason: "Units optional" }, null, ctx({ stored, hasOverride: true }))).toEqual({
      pointsCenti: null, feedback: null, whatStudentDid: null,
    });
    expect(overrideRequest({ ...untouched, points: "1", reason: "x" }, 100, ctx({ learnable: false }))).not.toHaveProperty("reason");
  });
});

describe("lessonStatusText", () => {
  const lesson = (o: Partial<NonNullable<ReviewItemView["lesson"]>> = {}): ReviewItemView["lesson"] => ({
    id: "l1", reason: "", active: true, sent: true, notSent: null, ...o,
  });

  it("says nothing without a lesson, or before a save", () => {
    expect(lessonStatusText(null, true)).toBeNull();
    expect(lessonStatusText(lesson(), false)).toBeNull();
  });

  it("always says when the lesson is turned off", () => {
    expect(lessonStatusText(lesson({ active: false, sent: false, notSent: "inactive" }), false)).toBe("This lesson is turned off on the Lessons tab.");
  });

  it("promises learning only for a lesson the grader is sent", () => {
    expect(lessonStatusText(lesson(), true)).toBe("Saved. The grader learns from this correction.");
    const notSent = ["agrees", "reading_fix", "no_reading", "limit"] as const;
    const texts = notSent.map((reason) => lessonStatusText(lesson({ sent: false, notSent: reason }), true));
    expect(texts).toEqual([
      "Saved. This matches the AI's judgment, so the grader learns from it only if you say why.",
      "Saved. The AI couldn't read this answer, so the grader learns from it only if you say why.",
      "Saved. The AI never read this answer, so the grader can't learn from it.",
      "Saved. Only the newest lessons fit, so the grader isn't sent this one.",
    ]);
    for (const text of texts) expect(text).not.toContain("learns from this correction");
  });
});
