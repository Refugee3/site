import { AutoRefresh } from "@/components/auto-refresh";
import { CopyButton } from "@/components/copy-button";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Spinner } from "@/components/ui/spinner";
import { formatPercent, formatPoints } from "@/lib/format";
import type { ReceiptNotice, ReceiptPhase, ReceiptView as ReceiptViewModel } from "@/lib/types";
import { SubmitAgain } from "./submit-again";

export interface ReceiptViewProps {
  view: ReceiptViewModel;
  /** Absolute link to this receipt, for the "save this link" box. */
  receiptUrl: string;
  /** `/r/<token>`: this receipt's path, as the upload form remembers it. */
  receiptPath: string;
}

const PHASE_STATUS: Record<ReceiptPhase, string> = {
  processing: "Received — being read…",
  checked: "Read — waiting for your teacher",
  released: "Feedback is ready",
  problem: "There was a problem reading your paper",
};

const NOTICE_TEXT: Record<ReceiptNotice, string> = {
  no_name: "We couldn't find your name on the paper.",
  wrong_assignment: "This might not be the right assignment, or it might not look like your work.",
  blank: "We couldn't find any answers on your paper.",
  pages_missing: "Some pages might be missing.",
};

// While the paper is being read the page polls, giving up after 30 minutes with a "Check again" button.
const POLL_MS = 5000;
const MAX_POLL_MS = 30 * 60 * 1000;

type ResultGroup = NonNullable<ReceiptViewModel["result"]>["groups"][number];
type ResultItem = ResultGroup["items"][number];

function pagesText(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

/** A student's receipt. Shows only what ReceiptView carries; AI text is rendered as plain text. */
export function ReceiptView({ view, receiptUrl, receiptPath }: ReceiptViewProps) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium uppercase tracking-wide text-muted">Receipt</p>
        <h1 className="text-2xl font-semibold text-balance break-words">{view.assignmentTitle}</h1>
        <p className="text-sm text-muted">
          Submitted <LocalTime ms={view.submittedAt} /> · {pagesText(view.pageCount)} ·{" "}
          <a href={view.pdfUrl} target="_blank" rel="noopener">
            View what you sent (PDF)
          </a>
        </p>
        <p role="status" className="text-base font-semibold">
          {PHASE_STATUS[view.phase]}
        </p>
      </header>

      {view.phase === "processing" && <Processing />}
      {view.phase === "problem" && (
        <Alert tone="danger" title="We couldn't finish reading your paper.">
          Your teacher has been notified.
        </Alert>
      )}
      {view.phase === "checked" && <Checked view={view} receiptPath={receiptPath} />}
      {view.phase === "released" && view.result && <Released result={view.result} />}

      <Card title="Save this link">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            This page is your receipt. Bookmark it or copy the link so you can see your feedback later.
          </p>
          <p className="break-all rounded-md bg-subtle px-3 py-2 font-mono text-sm">{receiptUrl}</p>
          <CopyButton value={receiptUrl} label="Copy link" />
        </div>
      </Card>
    </div>
  );
}

function Processing() {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Spinner className="mt-0.5 size-6 text-brand-600" />
        <div className="flex flex-col gap-1">
          <p className="text-lg font-semibold">We&apos;re reading your pages.</p>
          <p className="text-muted">This page updates by itself — you can keep it open or come back later.</p>
        </div>
      </div>
      <div className="mt-4 empty:hidden">
        <AutoRefresh intervalMs={POLL_MS} maxDurationMs={MAX_POLL_MS} />
      </div>
    </Card>
  );
}

function identityText(name: string | null, section: string | null): { lead: string; value: string } | null {
  if (name && section) return { lead: "We read your name as", value: `${name} · ${section}` };
  if (name) return { lead: "We read your name as", value: name };
  if (section) return { lead: "We read your class or section as", value: section };
  return null;
}

function Checked({ view, receiptPath }: { view: ReceiptViewModel; receiptPath: string }) {
  const identity = identityText(view.detectedName, view.detectedSection);
  return (
    <Card title="Your paper has been read">
      <div className="flex flex-col gap-4">
        {identity && (
          <p className="text-lg">
            {identity.lead} <strong className="font-semibold">{identity.value}</strong>.
          </p>
        )}
        {view.notices.length > 0 && (
          <Alert tone="warning" title="Please check">
            <ul className="list-disc pl-5">
              {view.notices.map((notice) => (
                <li key={notice}>{NOTICE_TEXT[notice]}</li>
              ))}
            </ul>
            <p className="mt-2">If something is wrong, fix your paper and submit it again.</p>
          </Alert>
        )}
        {view.notices.length > 0 && <SubmitAgain receiptPath={receiptPath} />}
        <p className="text-muted">
          Your teacher will share your score and feedback when they are ready. Check this page again later.
        </p>
      </div>
    </Card>
  );
}

function Released({ result }: { result: NonNullable<ReceiptViewModel["result"]> }) {
  return (
    <>
      <Card title="Your results">
        <div className="flex flex-col gap-4">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-semibold tabular-nums">
              {formatPoints(result.earnedCenti)} / {formatPoints(result.maxCenti)}
            </span>
            <span className="text-muted">points</span>
            {result.percentTenths !== null && (
              <span className="text-xl font-semibold tabular-nums text-muted">
                {formatPercent(result.percentTenths)}
              </span>
            )}
          </p>
          {result.overallFeedback && <p className="whitespace-pre-wrap leading-relaxed">{result.overallFeedback}</p>}
        </div>
      </Card>

      <section aria-labelledby="receipt-items-heading" className="flex flex-col gap-4">
        <h2 id="receipt-items-heading" className="text-lg font-semibold">
          Question by question
        </h2>
        <ol className="flex flex-col gap-4">
          {result.groups.map((group, index) => (
            <li key={`${index}:${group.groupLabel}`}>
              <ResultGroupView group={group} />
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function ResultGroupView({ group }: { group: ResultGroup }) {
  // Parts of a multi-part question share a heading; a standalone item is its own question.
  if (!group.groupLabel) {
    return (
      <ul className="flex flex-col gap-4">
        {group.items.map((item, index) => (
          <li key={`${index}:${item.label}`}>
            <ResultItemCard item={item} heading={`Question ${item.label}`} headingLevel={3} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Question {group.groupLabel}</h3>
      <ul className="flex flex-col gap-3 border-l-2 border-line pl-3">
        {group.items.map((item, index) => (
          <li key={`${index}:${item.label}`}>
            <ResultItemCard item={item} heading={`Part ${item.label}`} headingLevel={4} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultItemCard({ item, heading, headingLevel }: { item: ResultItem; heading: string; headingLevel: 3 | 4 }) {
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <Heading className="font-semibold">{heading}</Heading>
        <p className="shrink-0 font-semibold tabular-nums">
          {formatPoints(item.earnedCenti)} / {formatPoints(item.maxCenti)} pts
        </p>
      </div>
      {item.whatStudentDid && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">What you did</p>
          <p className="whitespace-pre-wrap leading-relaxed">{item.whatStudentDid}</p>
        </div>
      )}
      {item.feedback && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Feedback</p>
          <p className="whitespace-pre-wrap leading-relaxed">{item.feedback}</p>
        </div>
      )}
    </article>
  );
}
