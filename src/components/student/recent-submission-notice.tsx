"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import {
  forgetSubmission,
  pruneRecentSubmissions,
  readRecentSubmission,
  subscribeToStorage,
} from "@/lib/client/recent-submissions";

/**
 * Tells whoever opens the code page that a paper for this assignment was handed in from this device
 * recently. The device may be shared, so the wording does not assume it was this student, and the
 * receipt (another student's name, PDF and feedback) only appears after a deliberate tap. `canResubmit` is false when
 * the page takes no uploads (they are turned off, or the assignment is closed), so it never invites a new copy.
 */
export function RecentSubmissionNotice({ code, canResubmit }: { code: string; canResubmit: boolean }) {
  const recent = useSyncExternalStore(
    subscribeToStorage,
    () => readRecentSubmission(code, Date.now()),
    () => null,
  );
  // Which upload the receipt link was revealed for, so a newer upload starts hidden again.
  const [revealedAt, setRevealedAt] = useState<number | null>(null);

  useEffect(() => {
    pruneRecentSubmissions(Date.now());
  }, []);

  if (!recent) return null;
  const revealed = revealedAt === recent.at;
  return (
    <Alert tone="info">
      <p>
        A paper for this assignment was handed in from this device at <LocalTime ms={recent.at} />.
      </p>
      {canResubmit && <p className="mt-1">If that was you and you submit again, your teacher sees your newest copy.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {revealed ? (
          <Link href={recent.receiptUrl} className="font-medium">
            Open the receipt
          </Link>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setRevealedAt(recent.at)}>
            Show the receipt saved on this device
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => forgetSubmission(code)}>
          Not me — forget it
        </Button>
      </div>
    </Alert>
  );
}
