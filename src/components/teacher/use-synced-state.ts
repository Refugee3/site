import { useState } from "react";

/**
 * Local, editable state that starts from a server value and is replaced whenever that server value changes
 * (after a save, a regrade or an auto-refresh), so inputs never show stale data. `same` decides what counts
 * as a change; pass a content comparison for objects, which are re-created on every server render.
 */
export function useSyncedState<T>(
  serverValue: T,
  same: (a: T, b: T) => boolean = Object.is,
): [T, (value: T) => void] {
  const [value, setValue] = useState(serverValue);
  const [syncedFrom, setSyncedFrom] = useState(serverValue);
  if (!same(serverValue, syncedFrom)) {
    setSyncedFrom(serverValue);
    setValue(serverValue);
  }
  return [value, setValue];
}
