"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { deleteSubmissionAction, gradeManuallyAction, markReviewedAction, regradeSubmissionAction } from "@/actions/review";
import { CopyButton } from "@/components/copy-button";
import { FlagChips } from "@/components/flag-chips";
import { PdfFrame } from "@/components/pdf-frame";
import { StatusBadge } from "@/components/status-badge";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/link-button";
import { LocalTime } from "@/components/ui/local-time";
import { Spinner } from "@/components/ui/spinner";
import { STATUS_LABEL } from "@/lib/format";
import type { ReviewItemView, ReviewView } from "@/lib/types";
import { boardHref, reviewHref } from "./board-helpers";
import { IdentityForm } from "./identity-form";
import { ItemCard, itemFormKey } from "./item-card";
import { OverallFeedbackForm } from "./overall-feedback-form";
import { ScoreSummary } from "./score-summary";
import { plural } from "./text";
import { describeUnsaved, leaveUnsavedMessage, orderUnsaved } from "./unsaved-edits";
import { UnsavedEditsContext, useUnsavedEditsTracker } from "./unsaved-edits-context";
import { useActionRunner } from "./use-action-runner";
import { useLeaveGuard } from "./use-leave-guard";

export interface ReviewPanelProps {
  assignmentId: string;
  view: ReviewView;
}

/**
 * The review page: the student's PDF beside (on phones: above) everything the teacher checks and corrects,
 * with the paper-level actions in a bar pinned to the bottom of the screen.
 *
 * Each card saves on its own, so the forms report unsaved edits to the panel: leaving through a link asks
 * first, and marking the paper reviewed or regrading it waits until they are saved or undone.
 */
export function ReviewPanel({ assignmentId, view }: ReviewPanelProps) {
  const s = view.submission;
  // `jumps` counts page-link clicks, so clicking the same page again still brings it back into view.
  const [pdfView, setPdfView] = useState<{ page: number | null; jumps: number }>({ page: null, jumps: 0 });
  const pdfRef = useRef<HTMLDivElement>(null);
  const graded = s.status === "graded" || s.status === "needs_review";
  const [unsavedForms, unsavedTracker] = useUnsavedEditsTracker();
  const unsaved = orderUnsaved(unsavedForms, ["identity", "total", "overall", ...view.items.map((entry) => itemFormKey(entry.item.id))]);
  useLeaveGuard(unsaved.length > 0, leaveUnsavedMessage(unsaved));

  function showPage(page: number) {
    setPdfView((current) => ({ page, jumps: current.jumps + 1 }));
    // On phones the PDF sits above the cards; bring it back into view. On wide screens it is pinned already.
    const top = pdfRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) pdfRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <UnsavedEditsContext value={unsavedTracker}>
      <div className="flex flex-col gap-4">
        <ReviewHeader assignmentId={assignmentId} view={view} />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div ref={pdfRef} className="scroll-mt-4 lg:sticky lg:top-4 lg:self-start">
            {/* Remounting makes every browser's PDF viewer open at the page; a changed #page alone often does nothing. */}
            <PdfFrame key={pdfView.jumps} src={view.pdfUrl} title="The student's paper" page={pdfView.page} />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <StatusNotices view={view} />

            <Card title="Student">
              <IdentityForm submission={s} sections={view.sections} />
            </Card>

            {s.flags.length > 0 && (
              <Card title="Flags">
                <FlagChips flags={s.flags} detailed />
              </Card>
            )}

            <TeacherNotes view={view} />

            {graded && (
              <Card title="Score">
                <ScoreSummary
                  submissionId={s.id}
                  score={view.score}
                  totalOverrideCenti={s.totalOverrideCenti}
                  itemCount={view.items.length}
                />
              </Card>
            )}

            {graded && (
              <Card>
                <OverallFeedbackForm submissionId={s.id} overallFeedback={s.overallFeedback} edited={s.overallFeedbackEdited} />
              </Card>
            )}

            <ItemList assignmentId={assignmentId} submissionId={s.id} items={view.items} onShowPage={showPage} />
          </div>
        </div>

        <ReviewFooter assignmentId={assignmentId} view={view} unsaved={unsaved} />
      </div>
    </UnsavedEditsContext>
  );
}

function ReviewHeader({ assignmentId, view }: ReviewPanelProps) {
  const s = view.submission;
  const section = view.sectionLabel ?? (s.aiSectionRaw ? `“${s.aiSectionRaw}” (not matched)` : "No section");
  return (
    <div className="flex flex-col gap-2">
      <Link href={boardHref(assignmentId, "all")} className="self-start text-sm">
        ← All papers
      </Link>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-xl font-semibold">{s.studentName ?? "No name"}</h2>
        <span className="text-muted">{section}</span>
        <StatusBadge status={s.status} />
        {view.stale && <Badge tone="warning">Old key</Badge>}
        {s.reviewedAt !== null && <Badge tone="success">Reviewed</Badge>}
        {s.source === "teacher" && <Badge tone="neutral">Scanned copy</Badge>}
      </div>
      <p className="text-sm text-muted">
        Submitted <LocalTime ms={s.createdAt} /> · {plural(s.pageCount, "page")}
      </p>
      {view.earlierAttempts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span>Earlier attempts:</span>
          {view.earlierAttempts.map((attempt) => (
            <Link key={attempt.submissionId} href={reviewHref(assignmentId, attempt.submissionId)}>
              <LocalTime ms={attempt.createdAt} /> ({STATUS_LABEL[attempt.status]})
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusNotices({ view }: { view: ReviewView }) {
  const s = view.submission;
  const runner = useActionRunner();

  if (s.status === "queued" || s.status === "grading") {
    return (
      <Alert tone="info" title={s.status === "queued" ? "Waiting to be graded" : "The AI is reading this paper…"}>
        {s.statusNote && <p className="whitespace-pre-wrap">{s.statusNote}</p>}
        <p>This page updates by itself without replacing what you type. Save each change with its own Save button.</p>
      </Alert>
    );
  }

  if (s.status === "failed") {
    return (
      <Alert tone="danger" title="The AI couldn't grade this paper">
        <p className="whitespace-pre-wrap">{s.errorMessage ?? "Grading failed."}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={runner.pending} onClick={() => runner.run(() => regradeSubmissionAction(s.id))}>
            Try again
          </Button>
          <Button variant="secondary" size="sm" disabled={runner.pending} onClick={() => runner.run(() => gradeManuallyAction(s.id))}>
            Grade it myself
          </Button>
          {runner.pending && <Spinner className="size-4" />}
        </div>
        {runner.error && <p className="mt-2 font-medium">{runner.error}</p>}
      </Alert>
    );
  }

  if (view.stale) {
    return (
      <Alert tone="warning" title="Graded with an earlier version of the answer key">
        The score uses today&apos;s points, but the AI&apos;s judgments may not match the edited key. Regrade the paper to
        update them; your overrides are kept.
      </Alert>
    );
  }

  if (view.guidanceStale) {
    return (
      <Alert tone="info" title="Graded before your latest corrections">
        This paper was graded before your newest lessons or grading preferences. Regrade it to apply them; your
        overrides are kept.
      </Alert>
    );
  }
  return null;
}

/** What the AI wrote for the teacher only; plain text, never markup. */
function TeacherNotes({ view }: { view: ReviewView }) {
  const s = view.submission;
  const notes: Array<[string, string]> = [];
  if (s.teacherSummary) notes.push(["Summary", s.teacherSummary]);
  if (s.integrityNote) notes.push(["Text aimed at the grader", s.integrityNote]);
  if (s.unmatchedWork) notes.push(["Work that matches no question", s.unmatchedWork]);
  if (notes.length === 0) return null;
  return (
    <Card title="Notes from the AI">
      <dl className="flex flex-col gap-3 text-sm">
        {notes.map(([label, text]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="whitespace-pre-wrap text-muted">{text}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

interface ItemListProps {
  assignmentId: string;
  submissionId: string;
  items: ReviewItemView[];
  onShowPage: (page: number) => void;
}

/** Item cards, with a heading before the parts of each multi-part question. */
function ItemList({ assignmentId, submissionId, items, onShowPage }: ItemListProps) {
  return (
    <section aria-label="Questions" className="flex flex-col gap-3">
      {items.map((entry, index) => {
        const group = entry.item.groupLabel;
        const startsGroup = group !== "" && items[index - 1]?.item.groupLabel !== group;
        return (
          <div key={entry.item.id} className="flex flex-col gap-3">
            {startsGroup && <h3 className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted">Question {group}</h3>}
            <ItemCard assignmentId={assignmentId} submissionId={submissionId} entry={entry} onShowPage={onShowPage} />
          </div>
        );
      })}
    </section>
  );
}

type HeldAction = "review" | "regrade";

const HELD: Record<HeldAction, { before: string; anyway: string }> = {
  review: { before: "marking this paper reviewed", anyway: "Mark reviewed without saving" },
  regrade: { before: "regrading", anyway: "Regrade without saving" },
};

function ReviewFooter({ assignmentId, view, unsaved }: ReviewPanelProps & { unsaved: string[] }) {
  const s = view.submission;
  const router = useRouter();
  const runner = useActionRunner();
  const [allDone, setAllDone] = useState(false);
  // An action the teacher asked for while forms held unsaved edits; it waits for them to be saved or undone.
  const [held, setHeld] = useState<HeldAction | null>(null);
  const canRegrade = s.status === "graded" || s.status === "needs_review" || s.status === "failed";
  if (held !== null && unsaved.length === 0) setHeld(null);

  function markReviewedAndNext(withUnsaved = false) {
    if (!withUnsaved && unsaved.length > 0) {
      setHeld("review");
      return;
    }
    setHeld(null);
    runner.run(
      () => markReviewedAction(s.id),
      (result) => {
        const nextId = result.data?.nextId ?? null;
        if (nextId) router.push(reviewHref(assignmentId, nextId));
        else setAllDone(true);
      },
    );
  }

  function regrade(withUnsaved = false) {
    if (!withUnsaved && unsaved.length > 0) {
      setHeld("regrade");
      return;
    }
    setHeld(null);
    if (!window.confirm("Grade this paper again with the AI? Your point overrides, feedback edits and name changes are kept.")) return;
    runner.run(() => regradeSubmissionAction(s.id));
  }

  function remove() {
    // Lessons outlive their paper (the grader keeps learning from them), so say so: the teacher may be erasing a student.
    const lessons = view.items.filter((entry) => entry.lesson !== null).length;
    const them = lessons === 1 ? "it" : "them";
    const kept = lessons === 0 ? "" : ` The ${plural(lessons, "lesson")} from your corrections on it stay on the Lessons tab with this`
      + ` student's answer and your notes; delete ${them} there if you don't want ${them} kept.`;
    if (!window.confirm(`Delete this paper? Its grade is lost and the student's receipt link stops working.${kept}`)) return;
    // On success the action redirects to the board.
    runner.run(() => deleteSubmissionAction(s.id));
  }

  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-line bg-surface/95 px-4 py-3 shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur">
      {held !== null && (
        <Alert tone="warning" title="You have unsaved changes">
          <p>{describeUnsaved(unsaved, HELD[held].before)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={runner.pending}
              onClick={() => (held === "review" ? markReviewedAndNext(true) : regrade(true))}
            >
              {HELD[held].anyway}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setHeld(null)}>
              Keep editing
            </Button>
          </div>
        </Alert>
      )}
      {allDone && (
        <Alert tone="success" title="No more papers need review">
          {!view.released && <p>Students see their grades and notes once you release feedback on the Submissions page.</p>}
          <Link href={boardHref(assignmentId, "all")}>Back to all papers</Link>
        </Alert>
      )}
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Papers" className="flex gap-2">
          <NavLink href={view.prevId && reviewHref(assignmentId, view.prevId)} label="← Previous" />
          <NavLink href={view.nextId && reviewHref(assignmentId, view.nextId)} label="Next →" />
        </nav>
        <span className="hidden flex-1 sm:block" />
        <CopyButton value={view.receiptUrl} label="Copy student link" />
        {canRegrade && (
          <Button variant="secondary" size="sm" disabled={runner.pending} onClick={() => regrade()}>
            Regrade
          </Button>
        )}
        <Button variant="danger" size="sm" disabled={runner.pending} onClick={remove}>
          Delete
        </Button>
        {s.status === "needs_review" && (
          <Button disabled={runner.pending} onClick={() => markReviewedAndNext()}>
            {runner.pending && <Spinner className="size-4" />}
            Mark reviewed &amp; next
          </Button>
        )}
        {s.status !== "needs_review" && view.nextNeedsReviewId && (
          <LinkButton href={reviewHref(assignmentId, view.nextNeedsReviewId)}>Next to review</LinkButton>
        )}
      </div>
    </div>
  );
}

function NavLink({ href, label }: { href: string | null; label: string }) {
  if (!href) {
    return (
      <span aria-disabled="true" className="inline-flex min-h-11 items-center px-3 text-sm text-muted/60 sm:min-h-9">
        {label}
      </span>
    );
  }
  return (
    <LinkButton href={href} variant="secondary" size="sm">
      {label}
    </LinkButton>
  );
}
