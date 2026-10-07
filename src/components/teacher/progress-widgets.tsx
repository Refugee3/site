"use client";

import { useState } from "react";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Spinner } from "@/components/ui/spinner";
import {
  batchFraction, estimatedFraction, formatApproxDuration, formatClock, formatTimeLeft, remainingMs, secondsUntil, upperFirst,
} from "@/components/ui/time-estimates";
import { useServerClock } from "@/components/ui/use-server-clock";
import type { GradingProgress, ScanSplitProgress } from "@/lib/types";
import { plural } from "./text";

// Progress bars with running timers for work the server is doing. Every timestamp comes from the server; `serverNow` is
// when it rendered the page, so the estimates count down from there (see useServerClock). None of these sit in a live
// region: a timer that changes every second would be read out every second.

/** A running timer, "1:23", with its machine-readable duration. */
function Clock({ ms }: { ms: number }) {
  return (
    <time dateTime={`PT${Math.floor(Math.max(0, ms) / 1000)}S`} className="tabular-nums">
      {formatClock(ms)}
    </time>
  );
}

export interface GradingProgressCardProps {
  progress: GradingProgress;
  serverNow: number;
  /** WorkerStatus.throttledUntil: no new paper starts before then. */
  throttledUntil: number | null;
  /** The worker is paused or stopped (the banner above says why), so no estimate holds. */
  halted: boolean;
}

/** The latest time the papers now being graded can have started (so their credit is a lower bound), per batch and count. */
interface InFlightAnchor {
  startedAt: number;
  done: number;
  at: number;
}

function anchorFor(p: GradingProgress, serverNow: number): InFlightAnchor {
  // A paper starts when the batch does or when a slot frees up (another paper finishes). When this page first sees the
  // batch partway, it can't tell, so it starts the credit at zero: the bar stays conservative.
  return { startedAt: p.startedAt, done: p.done, at: p.done === 0 ? p.startedAt : serverNow };
}

/** The Submissions board's card for the grading batch: papers done, a bar, the time so far and the time left. */
export function GradingProgressCard({ progress: p, serverNow, throttledUntil, halted }: GradingProgressCardProps) {
  const now = useServerClock(serverNow);
  const [stored, setStored] = useState<InFlightAnchor>(() => anchorFor(p, serverNow));
  let anchor = stored;
  if (stored.startedAt !== p.startedAt || stored.done !== p.done) {
    // A paper finished (or a new batch began) since the last refresh: the next papers started about now.
    anchor = anchorFor(p, serverNow);
    setStored(anchor);
  }

  const fraction = batchFraction({
    done: p.done, total: p.total, grading: p.grading, inFlightElapsedMs: now - anchor.at, typicalPaperMs: p.typicalPaperMs,
  });
  const waitSeconds = throttledUntil !== null ? secondsUntil(throttledUntil, now) : 0;
  const left = remainingMs(p.etaMs, now - serverNow);

  return (
    <section
      aria-labelledby="grading-progress-heading"
      className="flex flex-col gap-3 rounded-xl border border-brand-100 bg-surface p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="grading-progress-heading" className="flex items-center gap-2 text-base font-semibold">
          <Spinner className="size-4 text-brand-600" />
          <span>
            Grading papers: <span className="tabular-nums">{p.done}</span> of <span className="tabular-nums">{p.total}</span> done
          </span>
        </h2>
        <p className="text-sm text-muted">
          {p.grading > 0 && `${p.grading} being graded`}
          {p.grading > 0 && p.queued > 0 && " · "}
          {p.queued > 0 && `${p.queued} waiting`}
        </p>
      </div>
      <ProgressBar value={fraction} label="Grading papers" valueText={`${p.done} of ${plural(p.total, "paper")} done`} />
      <p className="flex flex-wrap gap-x-2 gap-y-1 text-sm">
        <span>
          Time: <Clock ms={now - p.startedAt} />
        </span>
        <span aria-hidden="true" className="text-muted">·</span>
        {halted ? (
          <span className="text-warning-800">Grading is paused — see the notice at the top of the page.</span>
        ) : waitSeconds > 0 ? (
          <span className="text-warning-800">
            Anthropic asked us to slow down — continuing in <span className="tabular-nums">{waitSeconds}s</span>
          </span>
        ) : (
          <span className="text-muted">{upperFirst(formatTimeLeft(left))}</span>
        )}
      </p>
    </section>
  );
}

export interface EstimatedProgressProps {
  /** "Grading…", "Reading the answer key…" */
  label: string;
  /** What the bar measures, for screen readers ("Grading this paper"). */
  barLabel: string;
  startedAt: number;
  typicalMs: number;
  serverNow: number;
}

/** One piece of work with no progress to count: its time so far against how long it usually takes, and an estimated bar. */
export function EstimatedProgress({ label, barLabel, startedAt, typicalMs, serverNow }: EstimatedProgressProps) {
  const now = useServerClock(serverNow);
  const elapsed = now - startedAt;
  const fraction = estimatedFraction(elapsed, typicalMs);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="font-semibold">{label}</span>
        <span className="font-semibold">
          <Clock ms={elapsed} />
        </span>
        {/* On phones the typical time goes on a line of its own, without a dangling "·". */}
        <span className="text-muted max-sm:basis-full max-sm:first-letter:uppercase">
          <span className="max-sm:hidden">· </span>usually about {formatApproxDuration(typicalMs)}
        </span>
      </p>
      <ProgressBar
        value={fraction}
        estimated
        label={barLabel}
        valueText={`About ${Math.round(fraction * 100)}%, ${formatClock(elapsed)} so far`}
      />
    </div>
  );
}

/** A scan being split: pages read (a real count), the time so far and the estimated time left. */
export function ScanSplitProgressBar({ split, serverNow }: { split: ScanSplitProgress; serverNow: number }) {
  const now = useServerClock(serverNow);
  const fraction = split.pageCount > 0 ? split.pagesRead / split.pageCount : 0;
  return (
    <div className="flex flex-col gap-2">
      <ProgressBar
        value={fraction}
        label="Reading the scan"
        valueText={`Read ${split.pagesRead} of ${plural(split.pageCount, "page")}`}
      />
      <p className="text-sm text-muted">
        Read <span className="tabular-nums">{split.pagesRead}</span> of {plural(split.pageCount, "page")} ·{" "}
        <Clock ms={now - split.splitStartedAt} /> · {formatTimeLeft(remainingMs(split.etaMs, now - serverNow))}
      </p>
    </div>
  );
}
