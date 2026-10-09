import { describe, expect, it } from "vitest";
import { isKeySavedMessage, keySavedMessage, removeKeyQuestion } from "./api-key-messages";

describe("keySavedMessage", () => {
  it("promises grading with the key only when the server grades with Claude", () => {
    expect(keySavedMessage("claude")).toBe("Key saved and checked. Grading uses it from now on.");
    expect(keySavedMessage("fake")).toBe("Key saved and checked. It will be used once the server runs with AI_MODE=claude.");
  });

  it("tells the plain success messages from warnings", () => {
    expect(isKeySavedMessage(keySavedMessage("claude"))).toBe(true);
    expect(isKeySavedMessage(keySavedMessage("fake"))).toBe(true);
    expect(isKeySavedMessage("Key saved, but Anthropic couldn't be reached to check it.")).toBe(false);
  });
});

describe("removeKeyQuestion", () => {
  it("says what grading falls back to", () => {
    expect(removeKeyQuestion({ aiMode: "claude", envKeySet: true, unreadable: false }))
      .toBe("Remove the saved key? Grading switches to the server's ANTHROPIC_API_KEY.");
    expect(removeKeyQuestion({ aiMode: "claude", envKeySet: false, unreadable: false }))
      .toBe("Remove the saved key? Grading pauses until a key is added again.");
  });

  it("describes a key that can't be read, which grading already does without", () => {
    expect(removeKeyQuestion({ aiMode: "claude", envKeySet: true, unreadable: true }))
      .toBe("Remove the saved key that can't be read? Grading keeps using the server's ANTHROPIC_API_KEY.");
    expect(removeKeyQuestion({ aiMode: "claude", envKeySet: false, unreadable: true }))
      .toBe("Remove the saved key that can't be read? Grading stays paused until a key is added.");
  });

  it("claims no effect on grading in practice mode, which uses no key", () => {
    expect(removeKeyQuestion({ aiMode: "fake", envKeySet: false, unreadable: false })).toBe("Remove the saved key?");
    expect(removeKeyQuestion({ aiMode: "fake", envKeySet: true, unreadable: true })).toBe("Remove the saved key that can't be read?");
  });
});
