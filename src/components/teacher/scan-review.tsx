"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createPapersFromScanAction, deleteScanAction, retryScanWithAiAction, splitScanEveryAction } from "@/actions/scans";
import { PdfFrame } from "@/components/pdf-frame";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  aiProposedLayout, describePapers, droppedReason, expectedPagesPerPaper, formatPageRanges, paperNameLabel, sameLayout, toggleDropped,
  toggleStart, type ProposedPaper, type ScanPaperFlag,
} from "@/lib/scan-layout";
import type { ScanLayout, ScanPageReading, ScanReviewView, ScanStatus } from "@/lib/types";
import { plural } from "./text";
import { useActionRunner } from "./use-action-runner";
import { useLeaveGuard } from "./use-leave-guard";
import { useSyncedState } from "./use-synced-state";

export interface ScanReviewProps {
  assignmentId: string;
  view: ScanReviewView;
}

const DROPPED_LABEL: Record<ReturnType<typeof droppedReason>, string> = {
  blank: "Blank",
  cover: "Cover or separator",
  answer_key: "Answer key page",
  teacher: "Left out by you",
};

const PAGES_ERROR = "Enter the pages per student as a whole number from 1 to 100.";

function flagText(flag: ScanPaperFlag, paper: ProposedPaper, expected: number | null, maxPages: number): string {
  switch (flag) {
    case "low_confidence":
      return "Unsure where it starts";
    case "page_count":
      return `${plural(paper.pages.length, "page")} (most have ${expected})`;
    case "no_name":
      return "No name found";
    case "several_names":
      return "Several names";
    case "unread_pages":
      return "Some pages weren't read";
    case "too_many_pages":
      return `Over ${maxPages} pages`;
  }
}

/** Ids of a page's controls, so focus can follow the page when an edit moves its row or removes the control. */
const pageControlId = {
  start: (page: number) => `scan-page-${page}-start`,
  leaveOut: (page: number) => `scan-page-${page}-leave-out`,
  putBack: (page: number) => `scan-page-${page}-put-back`,
};

/** What the AI read on a page, in a few words for the page's row. */
function readingText(reading: ScanPageReading | null): string {
  if (!reading) return "";
  return [reading.studentName, reading.pageMarker, reading.note].filter((part) => part && part.trim()).join(" · ");
}

/**
 * The teacher's check of a split scan: which pages make up which student's paper. Every change stays in the
 * browser until "Grade N papers" sends the layout; a new split from the server (every N pages, the AI again)
 * remounts this component.
 */
export function ScanReview({ assignmentId, view }: ScanReviewProps) {
  const { scan } = view;
  const stored = scan.layout ?? [];
  const [layout, setLayout] = useSyncedState<ScanLayout>(stored, sameLayout);
  // `jumps` counts page-link clicks, so clicking the same page again still brings it back into view.
  const [pdfView, setPdfView] = useState<{ page: number | null; jumps: number }>({ page: null, jumps: 0 });
  const pdfRef = useRef<HTMLDivElement>(null);
  const runner = useActionRunner();
  const edited = !sameLayout(layout, stored);
  useLeaveGuard(edited, "Your changes to the split are not saved. Leave and lose them?");
  // An edit moves the page's row to another paper (remounting it) or removes the control that was used, which would
  // drop focus to the page itself; it goes to the page's control in its new place instead.
  const focusAfterEdit = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterEdit.current;
    if (id === null) return;
    focusAfterEdit.current = null;
    document.getElementById(id)?.focus();
  }, [layout]);

  function edit(next: ScanLayout, focusId: string) {
    focusAfterEdit.current = focusId;
    setLayout(next);
  }

  const papers = useMemo(
    () => describePapers(layout, scan.readings, { keyPageCount: view.keyPageCount, maxPagesPerPaper: view.maxPagesPerPaper }),
    [layout, scan.readings, view.keyPageCount, view.maxPagesPerPaper],
  );
  const expected = expectedPagesPerPaper(papers.map((paper) => paper.pages.length), view.keyPageCount);
  const keptCount = papers.reduce((sum, paper) => sum + paper.pages.length, 0);
  const droppedPages = layout.flatMap((page, i) => (page.dropped ? [i + 1] : []));
  // Kept after a split every N pages, so the AI's split is never lost.
  const proposed = aiProposedLayout(scan);
  const canReset = proposed !== null && !sameLayout(layout, proposed);
  const namesRead = scan.readings.length > 0;

  function showPage(page: number) {
    setPdfView((current) => ({ page, jumps: current.jumps + 1 }));
    // On phones the PDF sits above the papers; bring it back into view. On wide screens it is pinned already.
    const top = pdfRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) pdfRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function grade() {
    if (!window.confirm(`Create ${plural(papers.length, "paper")} and grade them? Each paper is one AI call.`)) return;
    runner.run(() => createPapersFromScanAction(scan.id, layout));
  }

  const split = scan.splitMode === "every" && !(proposed !== null && sameLayout(layout, proposed))
    ? ` · split every ${plural(scan.pagesPerPaper ?? 1, "page")}`
    : " · split by the AI";
  return (
    <div className="flex flex-col gap-4">
      {/* Announced after each change, which is otherwise silent for a screen reader. */}
      <p role="status" className="font-medium">
        {plural(papers.length, "paper")} from {plural(keptCount, "page")}
        {droppedPages.length > 0 && ` · ${plural(droppedPages.length, "page")} left out`}
        {split}
      </p>
      {!namesRead && <p className="text-sm text-muted">Names are read when each paper is graded.</p>}
      {papers.some((paper) => paper.flags.length > 0) && (
        <Alert tone="warning">Check the papers marked below before grading.</Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div ref={pdfRef} className="scroll-mt-4 lg:sticky lg:top-4 lg:self-start">
          {/* Remounting makes every browser's PDF viewer open at the page; a changed #page alone often does nothing. */}
          <PdfFrame key={pdfView.jumps} src={view.pdfUrl} title="The scan" page={pdfView.page} />
        </div>

        {/* Locked while the papers are created: the result replaces this whole view. */}
        <fieldset disabled={runner.pending} className="flex min-w-0 flex-col gap-4">
          <legend className="sr-only">Papers in this scan</legend>
          <ol className="flex flex-col gap-3">
            {papers.map((paper) => (
              <PaperCard
                key={paper.pages[0]}
                paper={paper}
                name={paperNameLabel(paper, namesRead)}
                firstKeptPage={papers[0].pages[0]}
                readings={scan.readings}
                describeFlag={(flag) => flagText(flag, paper, expected, view.maxPagesPerPaper)}
                onShowPage={showPage}
                onToggleStart={(page) => edit(toggleStart(layout, page - 1), pageControlId.start(page))}
                onLeaveOut={(page) => edit(toggleDropped(layout, page - 1), pageControlId.putBack(page))}
              />
            ))}
          </ol>

          {droppedPages.length > 0 && (
            <section aria-labelledby="scan-left-out-heading" className="flex flex-col gap-2">
              <h3 id="scan-left-out-heading" className="text-base font-semibold">
                Left out
              </h3>
              <ul className="flex flex-wrap gap-2">
                {droppedPages.map((page) => (
                  <li key={page} className="flex items-center gap-1 rounded-lg border border-line bg-subtle pl-1 text-sm">
                    <Button variant="ghost" size="sm" onClick={() => showPage(page)} aria-label={`Show page ${page} of the scan`}>
                      p.{page}
                    </Button>
                    <span className="text-muted">· {DROPPED_LABEL[droppedReason(scan.readings[page - 1] ?? null)]}</span>
                    <Button
                      id={pageControlId.putBack(page)}
                      variant="ghost"
                      size="sm"
                      onClick={() => edit(toggleDropped(layout, page - 1), pageControlId.leaveOut(page))}
                      aria-label={`Put back page ${page}`}
                    >
                      Put back
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <SplitEveryForm
              scanId={scan.id}
              defaultPages={scan.pagesPerPaper ?? view.keyPageCount ?? 1}
              label={scan.splitMode === "auto" ? "Split every N pages instead" : "Split every N pages"}
              confirmMessage={edited
                ? (pages) => `Replace your changes to the split with one paper every ${plural(pages, "page")}? Your changes are lost.`
                : undefined}
            />
            <RetryAiButton
              scanId={scan.id}
              label={namesRead ? "Have the AI split it again" : "Let the AI split it"}
              confirmMessage={`Have the AI read all ${plural(scan.pageCount, "page")} of the scan${namesRead ? " again" : ""}? `
                + "It takes a few AI calls, and the split shown here is replaced."}
            />
            <DeleteScanButton scanId={scan.id} status={scan.status} />
          </div>
        </fieldset>
      </div>

      <GradeBar
        assignmentId={assignmentId}
        view={view}
        papers={papers}
        pending={runner.pending}
        error={runner.error}
        onGrade={grade}
        onReset={canReset ? () => setLayout(proposed) : null}
      />
    </div>
  );
}

interface PaperCardProps {
  paper: ProposedPaper;
  /** paperNameLabel: null for a scan the AI never read. */
  name: string | null;
  /** The scan's first kept page always starts a paper. */
  firstKeptPage: number;
  readings: Array<ScanPageReading | null>;
  describeFlag: (flag: ScanPaperFlag) => string;
  onShowPage: (page: number) => void;
  onToggleStart: (page: number) => void;
  onLeaveOut: (page: number) => void;
}

function PaperCard({ paper, name, firstKeptPage, readings, describeFlag, onShowPage, onToggleStart, onLeaveOut }: PaperCardProps) {
  const headingId = `scan-paper-${paper.pages[0]}`;
  return (
    <li
      aria-labelledby={headingId}
      className={cx(
        "flex flex-col gap-3 rounded-xl border bg-surface p-4 shadow-sm",
        paper.flags.length > 0 ? "border-warning-200 ring-1 ring-warning-200" : "border-line",
      )}
    >
      <header className="flex flex-col gap-1">
        <h3 id={headingId} className="flex flex-wrap items-baseline gap-x-2 font-semibold">
          Paper {paper.index}
          {name !== null && <span className="font-normal">· {name}</span>}
          {paper.section && <span className="font-normal text-muted">· {paper.section}</span>}
        </h3>
        <p className="text-sm text-muted">
          {paper.pages.length === 1 ? "page" : "pages"} {formatPageRanges(paper.pages)}
        </p>
      </header>
      {paper.flags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Check">
          {paper.flags.map((flag) => (
            <li key={flag}>
              <Badge tone="warning">{describeFlag(flag)}</Badge>
            </li>
          ))}
        </ul>
      )}
      <ul className="flex flex-col divide-y divide-line">
        {paper.pages.map((page, i) => (
          <li key={page} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
            <Button variant="ghost" size="sm" onClick={() => onShowPage(page)} aria-label={`Show page ${page} of the scan`}>
              p.{page}
            </Button>
            <span className="min-w-0 flex-1 basis-32 break-words text-sm text-muted empty:hidden">{readingText(readings[page - 1] ?? null)}</span>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-9">
              <Input
                id={pageControlId.start(page)}
                type="checkbox"
                checked={i === 0}
                disabled={page === firstKeptPage}
                onChange={() => onToggleStart(page)}
              />
              New paper starts here<span className="sr-only"> (page {page})</span>
            </label>
            <Button
              id={pageControlId.leaveOut(page)}
              variant="ghost"
              size="sm"
              onClick={() => onLeaveOut(page)}
              aria-label={`Leave out page ${page}`}
            >
              Leave out
            </Button>
          </li>
        ))}
      </ul>
    </li>
  );
}

interface GradeBarProps {
  assignmentId: string;
  view: ScanReviewView;
  papers: ProposedPaper[];
  pending: boolean;
  error: string | null;
  onGrade: () => void;
  /** Null when the layout is the AI's own proposal (or the AI never split the scan). */
  onReset: (() => void) | null;
}

/** Why the papers can't be created yet, if anything stops them. */
function blockedReason(view: ScanReviewView, papers: ProposedPaper[]): string | null {
  if (!view.keyApproved) return "Approve the answer key first.";
  if (papers.length === 0) return "Keep at least one page.";
  if (papers.some((paper) => paper.flags.includes("too_many_pages"))) {
    return `Mark where the next paper starts in the papers marked “Over ${view.maxPagesPerPaper} pages”.`;
  }
  return null;
}

/** Pinned to the bottom of the screen: create and grade the papers, or go back to the AI's split. */
function GradeBar({ assignmentId, view, papers, pending, error, onGrade, onReset }: GradeBarProps) {
  const blocked = blockedReason(view, papers);
  // Approximate: on a re-run after a failure, papers already created from this scan don't count again.
  const overLimit = blocked === null && papers.length > view.remainingSubmissions;
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-line bg-surface/95 px-4 py-3 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button disabled={blocked !== null || pending} onClick={onGrade}>
          {pending && <Spinner className="size-4" />}
          Grade {plural(papers.length, "paper")}
        </Button>
        {onReset && (
          <Button variant="secondary" size="sm" disabled={pending} onClick={onReset}>
            Reset to the AI&apos;s split
          </Button>
        )}
        <p role="status" className="min-w-0 basis-full text-sm text-warning-800 empty:hidden sm:basis-auto sm:flex-1">
          {blocked}
          {overLimit && (
            <>
              This assignment can take only {plural(view.remainingSubmissions, "more paper", "more papers")}. Raise the limit
              in the assignment&apos;s <Link href={`/teacher/assignments/${assignmentId}/settings`}>Settings</Link>.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export interface SplitEveryFormProps {
  scanId: string;
  defaultPages: number;
  label: string;
  /** Asked before the split is replaced, when that loses something (the teacher's unsaved changes). */
  confirmMessage?: (pages: number) => string;
}

/** Splits the scan into papers of the same number of pages, replacing the current split. */
export function SplitEveryForm({ scanId, defaultPages, label, confirmMessage }: SplitEveryFormProps) {
  const runner = useActionRunner();
  const [pagesText, setPagesText] = useState(String(defaultPages));
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pages = Number(pagesText.trim());
    if (!Number.isInteger(pages) || pages < 1 || pages > 100) {
      setError(PAGES_ERROR);
      return;
    }
    setError(null);
    if (confirmMessage && !window.confirm(confirmMessage(pages))) return;
    runner.run(() => splitScanEveryAction(scanId, pages));
  }

  const shownError = error ?? runner.error;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            Pages per student
          </label>
          <div className="w-24">
            <Input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              aria-invalid={error ? true : undefined}
              value={pagesText}
              onChange={(e) => setPagesText(e.target.value)}
            />
          </div>
        </div>
        <Button type="submit" variant="secondary" disabled={runner.pending}>
          {runner.pending && <Spinner className="size-4" />}
          {label}
        </Button>
      </div>
      {shownError && <Alert tone="danger">{shownError}</Alert>}
    </form>
  );
}

/**
 * Sends the scan to the AI again: to split it from its first page, or (`mode` "one_pass", the default for a scan graded in one
 * pass) to go on grading it in one pass after the last part it finished. `confirmMessage` is asked first.
 */
export function RetryAiButton({ scanId, label = "Try the AI again", confirmMessage, mode }: {
  scanId: string;
  label?: string;
  confirmMessage?: string;
  mode?: "auto" | "one_pass";
}) {
  const runner = useActionRunner();

  function retry() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    runner.run(() => retryScanWithAiAction(scanId, mode));
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" className="self-start" disabled={runner.pending} onClick={retry}>
        {runner.pending && <Spinner className="size-4" />}
        {label}
      </Button>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </div>
  );
}

/** Deletes the scan (never while its papers are being created) and goes back to the upload tab. */
export function DeleteScanButton({ scanId, status }: { scanId: string; status: ScanStatus }) {
  const runner = useActionRunner();

  function remove() {
    if (!window.confirm("Delete this scan? Papers already created from it stay.")) return;
    // On success the action redirects to the upload tab.
    runner.run(() => deleteScanAction(scanId));
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="danger" className="self-start" disabled={status === "creating" || runner.pending} onClick={remove}>
        {runner.pending && <Spinner className="size-4" />}
        Delete scan
      </Button>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </div>
  );
}
