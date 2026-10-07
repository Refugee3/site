import Link from "next/link";
import { LocalTime } from "@/components/ui/local-time";
import { SCAN_STATUS_LABEL } from "@/lib/scan-layout";
import type { ScanSummary } from "@/lib/types";
import { plural } from "./text";

export interface ScanListProps {
  assignmentId: string;
  /** Newest first. */
  scans: ScanSummary[];
}

function statusText(scan: ScanSummary): string {
  if (scan.status !== "done" || scan.createdCount === null) return SCAN_STATUS_LABEL[scan.status];
  return `${plural(scan.createdCount, "paper")} created${scan.autoGraded ? ", grading started automatically" : ""}`;
}

/** The assignment's whole-class scans, each linking to its split check; renders nothing before the first one. */
export function ScanList({ assignmentId, scans }: ScanListProps) {
  if (scans.length === 0) return null;
  return (
    <section aria-labelledby="scan-list-heading" className="flex flex-col gap-3">
      <h3 id="scan-list-heading" className="text-base font-semibold">
        Earlier scans
      </h3>
      <ul className="flex flex-col gap-2">
        {scans.map((scan) => (
          <li
            key={scan.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2"
          >
            <p className="min-w-0 break-words text-sm">
              <span className="font-medium">{scan.originalFilename}</span>
              <span className="text-muted">
                {" · "}
                {plural(scan.pageCount, "page")} · {statusText(scan)} · <LocalTime ms={scan.createdAt} />
              </span>
            </p>
            <Link
              href={`/teacher/assignments/${assignmentId}/scans/${scan.id}`}
              aria-label={`Open ${scan.originalFilename}`}
              className="flex min-h-11 items-center text-sm font-medium sm:min-h-9"
            >
              Open
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
