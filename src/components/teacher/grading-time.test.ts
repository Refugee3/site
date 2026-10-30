import { describe, expect, it } from "vitest";
import { formatStepDuration, gradingTimeText, modelName, recentLocalTimeText } from "./grading-time";

describe("the time breakdown on a paper's review page", () => {
  it("reads \"Read: 48 s · Checked: 12 s · Model: gemma3:27b\" for a paper graded on this computer", () => {
    expect(gradingTimeText({ readMs: 48_200, judgeMs: 11_900, aiModel: "ollama:gemma3:27b" })).toBe("Read: 48 s · Checked: 12 s · Model: gemma3:27b");
  });

  it("says when no separate check was needed, names Claude models as stored, and shows nothing without recorded times", () => {
    expect(gradingTimeText({ readMs: 95_000, judgeMs: null, aiModel: "claude-sonnet-5-5" }))
      .toBe("Read: 1 min 35 s · Checked: not needed · Model: claude-sonnet-5-5");
    expect(gradingTimeText({ readMs: 3_000, judgeMs: 400, aiModel: null })).toBe("Read: 3 s · Checked: 1 s");
    expect(gradingTimeText({ readMs: null, judgeMs: null, aiModel: "ollama:qwen2.5vl:32b" })).toBeNull();
  });

  it("starts with the fast lane for a paper cut from a class scan by matching its pages to the blank worksheet", () => {
    expect(gradingTimeText({ readMs: 4_200, judgeMs: null, aiModel: "ollama:qwen2.5vl:32b", fastLane: true }))
      .toBe("Fast lane: matched pages to the blank worksheet · Read: 4 s · Checked: not needed · Model: qwen2.5vl:32b");
    expect(gradingTimeText({ readMs: 4_200, judgeMs: null, aiModel: null, fastLane: false })).toBe("Read: 4 s · Checked: not needed");
  });

  it("formats durations", () => {
    expect([0, 1_499, 59_400, 60_000, 125_000].map(formatStepDuration)).toEqual(["1 s", "1 s", "59 s", "1 min", "2 min 5 s"]);
    expect(modelName("ollama:qwen2.5vl:32b")).toBe("qwen2.5vl:32b");
  });
});

describe("the median time of recent local papers in Settings", () => {
  it("shows the median per paper, with reading and checking", () => {
    expect(recentLocalTimeText({ papers: 10, medianMs: 52_000, medianReadMs: 40_000, medianJudgeMs: 12_000 }))
      .toBe("Median of the last 10 papers graded on this computer: 52 s per paper (read 40 s, checked 12 s).");
    expect(recentLocalTimeText({ papers: 1, medianMs: 30_000, medianReadMs: 30_000, medianJudgeMs: 0 }))
      .toBe("Median of the last paper graded on this computer: 30 s per paper (read 30 s, checked without a separate step).");
    expect(recentLocalTimeText(null)).toBeNull();
  });
});
