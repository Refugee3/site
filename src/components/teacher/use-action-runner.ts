import { unstable_rethrow } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/types";

export const UNREACHABLE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

type Success<T> = Extract<ActionResult<T>, { ok: true }>;
type Failure = Extract<ActionResult, { ok: false }>;

export interface ActionRunner {
  /** True from the call until the action's result and the page refresh it triggered have rendered. */
  pending: boolean;
  error: string | null;
  /** `onFailure` also sees the field errors of a returned failure (not of a rejected call). */
  run: <T>(
    call: () => Promise<ActionResult<T>>,
    onSuccess?: (result: Success<T>) => void,
    onFailure?: (result: Failure) => void,
  ) => void;
}

/**
 * Calls server actions from event handlers. Each call runs in a transition, and a failure stays on screen:
 * a returned `{ ok: false }` and a rejected call (network down, server crash) both become `error`, so unsaved
 * input elsewhere on the page survives instead of being replaced by an error page. Next's own control flow
 * (a redirect after deleting, or to the login page when the session expired) is rethrown for Next to handle.
 */
export function useActionRunner(): ActionRunner {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run<T>(
    call: () => Promise<ActionResult<T>>,
    onSuccess?: (result: Success<T>) => void,
    onFailure?: (result: Failure) => void,
  ): void {
    setError(null);
    startTransition(async () => {
      let result: ActionResult<T>;
      try {
        result = await call();
      } catch (e) {
        unstable_rethrow(e);
        setError(UNREACHABLE_MESSAGE);
        return;
      }
      if (result.ok) {
        onSuccess?.(result);
      } else {
        setError(result.error);
        onFailure?.(result);
      }
    });
  }

  return { pending, error, run };
}
