import { useState, useSyncExternalStore } from "react";

/** Wakes the subscriber just after each whole second of the browser's clock. */
function subscribeEverySecond(onTick: () => void): () => void {
  let timer: number | undefined;
  const schedule = () => {
    timer = window.setTimeout(() => {
      onTick();
      schedule();
    }, 1000 - (Date.now() % 1000) + 15);
  };
  schedule();
  return () => window.clearTimeout(timer);
}

// Whole seconds, so consecutive reads within one second return the same snapshot (as useSyncExternalStore requires).
const browserSecond = () => Math.floor(Date.now() / 1000) * 1000;
const noBrowserClock = () => null;

/** A refreshed page whose clock difference is off by more than this re-measures it (the page was restored from a cache). */
const RESYNC_MS = 3000;

/**
 * The current time on the server's clock (epoch ms), ticking every second, for running timers and estimates measured
 * from server timestamps. `serverNow` is when the server rendered the page.
 *
 * The server HTML and the hydrating render both use `serverNow` itself, so they always match (no hydration mismatch);
 * the ticking starts right after hydration. The browser's clock may differ from the server's, so the first tick
 * measures the difference and keeps it: timers don't jitter each time the page refreshes with a newer `serverNow`.
 * Only a refresh that is far off (a page restored from the browser's cache) measures it again.
 */
export function useServerClock(serverNow: number): number {
  const browserNow = useSyncExternalStore(subscribeEverySecond, browserSecond, noBrowserClock);
  const [sync, setSync] = useState<{ serverNow: number; offset: number } | null>(null);
  if (browserNow === null) return serverNow;
  const measured = serverNow - browserNow;
  if (sync === null || (sync.serverNow !== serverNow && Math.abs(measured - sync.offset) > RESYNC_MS)) {
    // Stored during render (React re-renders straight away), so the first ticking frame already uses it.
    setSync({ serverNow, offset: measured });
    return serverNow;
  }
  if (sync.serverNow !== serverNow) setSync({ serverNow, offset: sync.offset });
  return browserNow + sync.offset;
}
