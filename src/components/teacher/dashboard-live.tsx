"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { dashboardLiveSignature, type DashboardLiveSnapshot } from "@/lib/live/snapshot";
import { useEventSource } from "./use-event-source";

/** Polling instead, when the browser can't keep the live connection: while anything is busy. */
const FALLBACK_POLL_MS = 4000;

/**
 * Keeps the dashboard's server-rendered cards current: the live stream (GET /api/teacher/live) says when one of them changed
 * (a key read, a paper graded, a scan split), and the page re-renders in place. Without the stream, it polls while `busy`, as
 * the dashboard did before.
 */
export function DashboardLive({ busy }: { busy: boolean }) {
  const router = useRouter();
  const last = useRef<string | null>(null);
  const { failed } = useEventSource<DashboardLiveSnapshot>("/api/teacher/live", (snapshot) => {
    const signature = dashboardLiveSignature(snapshot);
    if (last.current !== null && last.current !== signature) router.refresh();
    last.current = signature;
  });
  return failed ? <AutoRefresh intervalMs={busy ? FALLBACK_POLL_MS : null} /> : null;
}
