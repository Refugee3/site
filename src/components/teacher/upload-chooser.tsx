"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import type { UploadPageView } from "@/lib/types";
import { BulkUpload } from "./bulk-upload";
import { ScanUpload } from "./scan-upload";

export interface UploadChooserProps {
  assignmentId: string;
  view: UploadPageView;
}

type UploadKind = "per_student" | "stack";

/**
 * The two ways to upload papers: one file per student, or one scan of the whole stack that the AI splits.
 * Both uploaders stay mounted, so switching never cancels uploads that are still running.
 */
export function UploadChooser({ assignmentId, view }: UploadChooserProps) {
  const [kind, setKind] = useState<UploadKind>("per_student");
  const options: Array<{ value: UploadKind; label: string; description: string }> = [
    {
      value: "per_student",
      label: "One file per student",
      description: `Each student's paper as its own PDF, photo, Word or text file, up to ${view.maxUploadMb} MB and ${view.maxPages} pages each.`,
    },
    {
      value: "stack",
      label: "One scan of the whole stack",
      description: `Scan the whole class's papers into one PDF (or a set of photos), up to ${view.maxScanMb} MB and ${view.maxScanPages} pages. The AI finds where each student's paper starts. A clean split is graded automatically; a split with anything to check waits for you.`,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="sr-only">How are the papers scanned?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-lg border border-line-strong bg-surface p-3 has-checked:border-brand-600 has-checked:bg-brand-50"
            >
              <input
                type="radio"
                name="upload-kind"
                value={option.value}
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
                className="mt-0.5 size-5 shrink-0 accent-brand-600"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className="text-sm text-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div hidden={kind !== "per_student"}>
        <Card>
          <div className="flex flex-col gap-4">
            {view.studentsCanUpload && (
              <p className="text-sm text-muted">
                Each upload gives you the student&apos;s receipt link, where they see their feedback once you release it.
              </p>
            )}
            <BulkUpload uploadUrl={`/api/teacher/assignments/${assignmentId}/submissions`} disabled={!view.keyApproved} />
          </div>
        </Card>
      </div>
      <div hidden={kind !== "stack"}>
        <Card>
          <ScanUpload
            uploadUrl={`/api/teacher/assignments/${assignmentId}/scans`}
            disabled={!view.keyApproved}
            keyPageCount={view.keyPageCount}
          />
        </Card>
      </div>
    </div>
  );
}
