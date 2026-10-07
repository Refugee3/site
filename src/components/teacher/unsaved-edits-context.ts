import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { withUnsaved } from "./unsaved-edits";

/** Lets the separate forms of a page tell the page which of them hold unsaved edits. */
export interface UnsavedEdits {
  /** Marks the form `key` as holding unsaved edits under `label`, or (with null) as clean. */
  set: (key: string, label: string | null) => void;
}

export const UnsavedEditsContext = createContext<UnsavedEdits | null>(null);

/** For the page: which forms hold unsaved edits (form key → label), and the tracker to provide to them. */
export function useUnsavedEditsTracker(): [ReadonlyMap<string, string>, UnsavedEdits] {
  const [unsaved, setUnsaved] = useState<ReadonlyMap<string, string>>(() => new Map());
  const tracker = useMemo<UnsavedEdits>(
    () => ({ set: (key, label) => setUnsaved((current) => withUnsaved(current, key, label)) }),
    [],
  );
  return [unsaved, tracker];
}

/** For a form: reports its unsaved edits to the page while `dirty` (a no-op outside a tracking page). */
export function useReportUnsaved(key: string, label: string, dirty: boolean): void {
  const tracker = useContext(UnsavedEditsContext);
  useEffect(() => {
    if (!tracker || !dirty) return;
    tracker.set(key, label);
    return () => tracker.set(key, null);
  }, [tracker, key, label, dirty]);
}
