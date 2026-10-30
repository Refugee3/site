// Messages about the app's API key that depend on how the server runs: the practice grader (AI_MODE=fake) uses no
// key, so nothing about grading changes when one is saved or removed.

export type AiMode = "claude" | "fake";

/** saveApiKeyAction's message when the key was saved and checked, with nothing to warn about. */
export function keySavedMessage(aiMode: AiMode): string {
  return aiMode === "fake"
    ? "Key saved and checked. It will be used once the server runs with AI_MODE=claude."
    : "Key saved and checked. Grading uses it from now on.";
}

/** Whether a save's message is the plain success one (any other is a warning). */
export function isKeySavedMessage(message: string): boolean {
  return message === keySavedMessage("claude") || message === keySavedMessage("fake");
}

/** The confirmation before the saved key is removed: what grading falls back to. */
export function removeKeyQuestion(k: { aiMode: AiMode; envKeySet: boolean; unreadable: boolean }): string {
  const question = k.unreadable ? "Remove the saved key that can't be read?" : "Remove the saved key?";
  if (k.aiMode === "fake") return question;
  if (k.envKeySet) return `${question} Grading ${k.unreadable ? "keeps using" : "switches to"} the server's ANTHROPIC_API_KEY.`;
  return k.unreadable ? `${question} Grading stays paused until a key is added.` : `${question} Grading pauses until a key is added again.`;
}
