import { describe, expect, it } from "vitest";
import { engineSavedMessage, formatAgentTime, HOSTED_AGENT_READY } from "@/lib/grader-engine-messages";

describe("engineSavedMessage", () => {
  it("names the engine that grades from the next paper on", () => {
    expect(engineSavedMessage("agent")).toBe(
      "Saved. The hosted agent grades from the next paper on; papers already being graded finish as they started.",
    );
    expect(engineSavedMessage("direct")).toBe(
      "Saved. The direct API grades from the next paper on; papers already being graded finish as they started.",
    );
  });

  it("says when the hosted agent is set up", () => {
    expect(HOSTED_AGENT_READY).toBe("The hosted agent is ready.");
  });
});

describe("formatAgentTime", () => {
  it.each([
    [0, "under a minute"],
    [59, "under a minute"],
    [60, "1 min"],
    [119, "1 min"],
    [3599, "59 min"],
    [3600, "1 h"],
    [3659, "1 h"],
    [3900, "1 h 5 min"],
    [90_000, "25 h"],
  ])("formats %i seconds as %j", (seconds, text) => {
    expect(formatAgentTime(seconds)).toBe(text);
  });
});
