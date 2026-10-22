import { describe, expect, it } from "vitest";
import type { QuestionSpots } from "@/lib/omr/types";
import { boxFromDrag, moveBox, newSpot, nextOptionValue, resizeBox, spotTitle, summarize, withBox, withKind } from "./spot-model";

const box = { x: 0.1, y: 0.2, w: 0.2, h: 0.05 };
const choice: QuestionSpots = {
  id: "s1", label: "3", itemLabel: "3", kind: "choice", multi: false, enabled: true, page: 1,
  options: [{ value: "A", box }, { value: "B", box: { ...box, x: 0.4 } }], boxes: [],
};

describe("answer-spot editor helpers", () => {
  it("titles questions by their spots", () => {
    expect(spotTitle(choice)).toBe("Q3: A B");
    expect(spotTitle({ ...choice, label: "5", kind: "write_in", options: [] })).toBe("Q5: write-in");
    expect(spotTitle({ ...choice, label: "Bonus", kind: "diagram", options: [] })).toBe("Bonus: drawing");
  });

  it("moves and resizes boxes within the page", () => {
    expect(moveBox(box, 0.85, -0.5)).toEqual({ ...box, x: 0.8, y: 0 });
    const r = resizeBox(box, "se", 0.1, 0.05);
    expect(r.w).toBeCloseTo(0.3);
    expect(r.h).toBeCloseTo(0.1);
    const tiny = resizeBox(box, "nw", 0.5, 0.5);
    expect(tiny.w).toBeGreaterThan(0);
    expect(tiny.x + tiny.w).toBeCloseTo(0.3);
    const drawn = boxFromDrag({ x: 0.5, y: 0.5 }, { x: 0.3, y: 0.45 })!;
    expect([drawn.x, drawn.y, drawn.w, drawn.h].map((n) => Math.round(n * 100) / 100)).toEqual([0.3, 0.45, 0.2, 0.05]);
    expect(boxFromDrag({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.6 })).toBeNull();
  });

  it("changes a question's kind, keeping where it is answered", () => {
    const written = withKind(choice, "write_in");
    expect(written.options).toEqual([]);
    expect(written.boxes).toHaveLength(1);
    expect(written.boxes[0].x).toBeCloseTo(0.1);
    expect(written.boxes[0].w).toBeCloseTo(0.5);
    const back = withKind(written, "choice");
    expect(back.options.map((o) => o.value)).toEqual(["A", "B"]);
  });

  it("adds options with the next value, and areas to written answers", () => {
    expect(nextOptionValue(choice)).toBe("C");
    expect(withBox(choice, box).options.map((o) => o.value)).toEqual(["A", "B", "C"]);
    expect(nextOptionValue({ ...choice, options: [{ value: "1", box }] })).toBe("2");
    expect(withBox(written(), box).boxes).toHaveLength(2);
  });

  it("links a new spot to the first key item without one", () => {
    const s = newSpot([choice], 2, box, [{ label: "3", kind: "choice" }, { label: "4", kind: "write_in" }]);
    expect(s).toMatchObject({ label: "4", itemLabel: "4", kind: "write_in", page: 2, boxes: [box] });
    expect(summarize([choice, s], ["3", "4", "5"])).toEqual({ used: 2, choice: 1, written: 1, missing: ["5"] });
  });
});

function written(): QuestionSpots {
  return withKind(choice, "write_in");
}
