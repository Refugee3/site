"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/** After this many failed connections in a row, the page stops trying and falls back to polling. */
const MAX_FAILURES = 3;

/**
 * Subscribes to a Server-Sent Events stream of "snapshot" events (JSON) while mounted. The browser reconnects by itself after a
 * dropped or closed connection; `failed` turns true once it can't connect MAX_FAILURES times in a row (or EventSource is
 * missing), so the page can fall back to polling. A "gone" event (deleted, logged out) closes it for good.
 */
export function useEventSource<T>(url: string, onSnapshot: (snapshot: T) => void): { failed: boolean; connected: boolean } {
  const [failed, setFailed] = useState(false);
  const [connected, setConnected] = useState(false);
  const handler = useRef(onSnapshot);
  // Assumed present in the server HTML; checked in the browser.
  const supported = useSyncExternalStore(subscribeNever, () => typeof EventSource !== "undefined", () => true);

  useEffect(() => {
    handler.current = onSnapshot;
  });

  useEffect(() => {
    if (!supported) return;
    let failures = 0;
    const source = new EventSource(url);
    source.addEventListener("open", () => {
      failures = 0;
      setConnected(true);
      setFailed(false);
    });
    source.addEventListener("snapshot", (event) => {
      try {
        handler.current(JSON.parse((event as MessageEvent<string>).data) as T);
      } catch {
        // a malformed event is skipped; the next one replaces it
      }
    });
    source.addEventListener("gone", () => {
      source.close();
      setConnected(false);
      setFailed(true);
    });
    source.addEventListener("error", () => {
      setConnected(false);
      // A stream that ends normally (its maximum lifetime) reconnects at once; only repeated failures count.
      if (source.readyState === EventSource.CLOSED || ++failures >= MAX_FAILURES) {
        source.close();
        setFailed(true);
      }
    });
    return () => source.close();
  }, [url, supported]);

  return { failed: failed || !supported, connected };
}
