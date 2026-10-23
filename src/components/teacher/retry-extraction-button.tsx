"use client";

import { retryKeyExtractionAction } from "@/actions/key";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ButtonVariant } from "@/components/ui/button-styles";
import { Spinner } from "@/components/ui/spinner";
import { useActionRunner } from "./use-action-runner";

export interface RetryExtractionButtonProps {
  assignmentId: string;
  label: string;
  /** Asked before starting, when re-reading would throw away the current items. */
  confirmText?: string;
  variant?: ButtonVariant;
}

/** Sends the stored key PDF to the AI again. */
export function RetryExtractionButton({ assignmentId, label, confirmText, variant = "primary" }: RetryExtractionButtonProps) {
  const runner = useActionRunner();

  function retry() {
    if (confirmText && !window.confirm(confirmText)) return;
    runner.run(() => retryKeyExtractionAction(assignmentId));
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant={variant} className="self-start" disabled={runner.pending} onClick={retry}>
        {runner.pending && <Spinner className="size-4" />}
        {label}
      </Button>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </div>
  );
}
