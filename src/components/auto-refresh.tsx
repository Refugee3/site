"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export interface AutoRefreshProps {
  /** Milliseconds between refreshes; null turns polling off. */
  intervalMs: number | null;
  /** Stop polling after this long and offer a manual "Check again" instead. */
  maxDurationMs?: number;
}

/**
 * Re-renders the current route's Server Components every `intervalMs` (router.refresh, no JSON endpoints).
 * Polling skips ticks while the tab is hidden and refreshes as soon as it becomes visible again.
 */
export function AutoRefresh({ intervalMs, maxDurationMs }: AutoRefreshProps) {
  const router = useRouter();
  // Clearing `expired` ("Check again") re-runs the effect, which restarts polling with a fresh time budget.
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (intervalMs === null || expired) return;
    const startedAt = Date.now();
    const outOfTime = () => maxDurationMs !== undefined && Date.now() - startedAt >= maxDurationMs;

    const timer = window.setInterval(() => {
      if (outOfTime()) {
        window.clearInterval(timer);
        setExpired(true);
      } else if (!document.hidden) {
        router.refresh();
      }
    }, intervalMs);

    const onVisibilityChange = () => {
      if (!document.hidden && !outOfTime()) router.refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, maxDurationMs, expired, router]);

  if (!expired || intervalMs === null) return null;

  const checkAgain = () => {
    setExpired(false);
    router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
      <p role="status">This is taking longer than usual. Refresh to check again.</p>
      <Button variant="secondary" size="sm" onClick={checkAgain}>
        Check again
      </Button>
    </div>
  );
}
