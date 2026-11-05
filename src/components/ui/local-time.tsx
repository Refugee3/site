"use client";

import { useSyncExternalStore } from "react";
import { formatDateTime } from "@/lib/format";

const subscribeNever = () => () => {};

/**
 * A timestamp in the viewer's own locale and time zone. The server does not know either, so it renders an
 * empty <time> and the text appears right after hydration (no mismatch warning, no wrong-zone flash).
 */
export function LocalTime({ ms, className }: { ms: number; className?: string }) {
  const text = useSyncExternalStore(
    subscribeNever,
    () => formatDateTime(ms),
    () => "",
  );
  return (
    <time dateTime={new Date(ms).toISOString()} className={className}>
      {text}
    </time>
  );
}
