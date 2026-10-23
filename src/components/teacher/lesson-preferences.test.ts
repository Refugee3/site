import { describe, expect, it } from "vitest";
import { addToPreferencesBlocker } from "./lesson-preferences";

describe("addToPreferencesBlocker", () => {
  it("allows adding the saved reason as shown", () => {
    expect(addToPreferencesBlocker("Units are optional.", "Units are optional.")).toBeNull();
  });

  it("asks for a reason when the box is empty, even when one is saved", () => {
    expect(addToPreferencesBlocker("", "")).toBe("Write a reason first");
    expect(addToPreferencesBlocker("  ", "Units are optional.")).toBe("Write a reason first");
  });

  it("asks to save a reason that was edited or typed but not saved, so the old one is never added", () => {
    expect(addToPreferencesBlocker("Units are optional in Q1.", "Units are optional.")).toBe("Save the reason first");
    expect(addToPreferencesBlocker("Units are optional.", "")).toBe("Save the reason first");
  });
});
