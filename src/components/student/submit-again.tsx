"use client";

import { useSyncExternalStore } from "react";
import { LinkButton } from "@/components/ui/link-button";
import { codeForReceipt, subscribeToStorage } from "@/lib/client/recent-submissions";

/**
 * "Submit again" for the browser that made this upload, which remembers the share code it used for a
 * few hours. The receipt itself never carries the code, so a rotated code does not leak through old
 * receipt links; elsewhere (and later, or after a rotation, where the old code no longer works) the
 * student is pointed back to the teacher's link.
 */
export function SubmitAgain({ receiptPath }: { receiptPath: string }) {
  const code = useSyncExternalStore(subscribeToStorage, () => codeForReceipt(receiptPath, Date.now()), () => null);
  if (!code) return <p className="text-muted">To submit again, open the link your teacher shared.</p>;
  return (
    <LinkButton href={`/s/${code}`} variant="secondary" className="self-start">
      Submit again
    </LinkButton>
  );
}
