"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Alert } from "@/components/ui/alert";
import { LocalTime } from "@/components/ui/local-time";
import { parseRecentSubmission, readRecentSubmissionRaw, subscribeToStorage } from "@/lib/client/recent-submissions";

/** "You submitted at … · View receipt" for a student who already uploaded to this assignment on this device. */
export function RecentSubmissionNotice({ code }: { code: string }) {
  const raw = useSyncExternalStore(
    subscribeToStorage,
    () => readRecentSubmissionRaw(code),
    () => null,
  );
  const recent = parseRecentSubmission(raw, code);
  if (!recent) return null;
  return (
    <Alert tone="success">
      <p>
        You submitted at <LocalTime ms={recent.at} /> · <Link href={recent.receiptUrl}>View receipt</Link>
      </p>
      <p className="mt-1">If you submit again, your teacher sees your newest copy.</p>
    </Alert>
  );
}
