/** "A", "A and B", "A, B and C". */
export function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * `unsaved` with `key` set to `label`, or removed when `label` is null. Returns the same map when nothing
 * changes, so a form reporting the same state again does not re-render the page.
 */
export function withUnsaved(unsaved: ReadonlyMap<string, string>, key: string, label: string | null): ReadonlyMap<string, string> {
  if (label === null ? !unsaved.has(key) : unsaved.get(key) === label) return unsaved;
  const next = new Map(unsaved);
  if (label === null) next.delete(key);
  else next.set(key, label);
  return next;
}

/** The labels of the forms with unsaved edits, in page order (`order` lists the form keys top to bottom). */
export function orderUnsaved(unsaved: ReadonlyMap<string, string>, order: readonly string[]): string[] {
  const position = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  return [...unsaved.entries()].sort(([a], [b]) => position(a) - position(b)).map(([, label]) => label);
}

/** The confirm text before a link takes the teacher away from forms with unsaved edits. */
export function leaveUnsavedMessage(labels: readonly string[]): string {
  return `You have unsaved changes on ${listInWords(labels)}. Leave without saving them?`;
}

/** Why a paper-level action (mark reviewed, regrade) waits: which forms still hold unsaved edits. */
export function describeUnsaved(labels: readonly string[], before: string): string {
  const these = labels.length === 1 ? "it" : "them";
  return `Your changes on ${listInWords(labels)} aren't saved yet. Save ${these} with ${labels.length === 1 ? "its" : "their"} own Save button, or undo ${these}, before ${before}.`;
}
