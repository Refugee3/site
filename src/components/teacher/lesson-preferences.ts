/**
 * Why "Add to my grading preferences" can't be used yet, or null when it can. The server adds the saved reason, so the
 * button follows the text in the box: a reason typed but not saved would otherwise add the old one.
 */
export function addToPreferencesBlocker(typedReason: string, savedReason: string): string | null {
  if (typedReason.trim() === "") return "Write a reason first";
  if (typedReason !== savedReason) return "Save the reason first";
  return null;
}
