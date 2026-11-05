import { useCallback, useState } from "react";

export interface Synced<T> {
  /** What the input shows. */
  value: T;
  /** The server value `value` was last brought in line with. */
  syncedFrom: T;
  /** The next server value replaces `value` even when it was edited: set right before the form saves it. */
  adoptNext: boolean;
}

/**
 * The state once the server value is `server`. An untouched input follows the server; an edited one keeps
 * the teacher's text, so an auto-refresh (grading finishing, a regrade) never overwrites unsaved typing.
 * After the form's own save (`adoptNext`) the server's stored version replaces the edit, so normalization
 * (trimmed text, "3.50" stored as 3.5) shows. Returns `prev` itself when the server value has not changed.
 */
export function nextSynced<T>(prev: Synced<T>, server: T, same: (a: T, b: T) => boolean): Synced<T> {
  if (same(server, prev.syncedFrom)) return prev;
  const edited = !same(prev.value, prev.syncedFrom);
  return { value: edited && !prev.adoptNext ? prev.value : server, syncedFrom: server, adoptNext: false };
}

/**
 * Local, editable state that starts from a server value and follows it while the teacher has not edited it
 * (see `nextSynced`). `same` decides what counts as a change; pass a content comparison for objects, which
 * are re-created on every server render. The third element marks the next server value as the result of the
 * form's own save (call it right before saving; `false` withdraws that after a failed save).
 */
export function useSyncedState<T>(
  serverValue: T,
  same: (a: T, b: T) => boolean = Object.is,
): [T, (value: T) => void, (expect?: boolean) => void] {
  const [state, setState] = useState<Synced<T>>(() => ({ value: serverValue, syncedFrom: serverValue, adoptNext: false }));
  const next = nextSynced(state, serverValue, same);
  if (next !== state) setState(next);
  const setValue = useCallback((value: T) => setState((current) => ({ ...current, value })), []);
  const expectSave = useCallback((expect = true) => setState((current) => ({ ...current, adoptNext: expect })), []);
  return [next.value, setValue, expectSave];
}
