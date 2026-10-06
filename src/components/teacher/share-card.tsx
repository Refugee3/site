import { CopyButton } from "@/components/copy-button";
import { formatShareCode } from "@/lib/format";
import type { AssignmentStatus } from "@/lib/types";

export interface ShareCardProps {
  shareUrl: string;
  shareCode: string;
  status: AssignmentStatus;
}

const STATUS_NOTE: Record<AssignmentStatus, string> = {
  draft: "Not open yet: students who use the code are told to wait until you open the assignment.",
  open: "Open: students can hand in work with the code or the link.",
  closed: "Closed: students are told that submissions are closed.",
};

/** What students need to hand in work: the code to type on the start page and the direct link. */
export function ShareCard({ shareUrl, shareCode, status }: ShareCardProps) {
  return (
    <section aria-labelledby="share-heading" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h2 id="share-heading" className="text-sm font-semibold text-muted">
        Share with students
      </h2>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Code</p>
          <p className="font-mono text-3xl font-semibold tracking-[0.2em] text-ink">{formatShareCode(shareCode)}</p>
        </div>
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Link</p>
          <p className="break-all font-mono text-sm">{shareUrl}</p>
          <CopyButton value={shareUrl} label="Copy link" />
        </div>
      </div>
      <p className="text-sm text-muted">{STATUS_NOTE[status]}</p>
    </section>
  );
}
