"use client";

import { useOptimistic } from "react";
import { setStudentUploadsAction } from "@/actions/settings";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { useActionRunner } from "./use-action-runner";

/** The app-wide switch that lets students hand in work through codes and links. */
export function StudentUploadsSwitch({ enabled }: { enabled: boolean }) {
  const runner = useActionRunner();
  // The switch moves at once; it settles on the stored value when the action and refresh finish (or fail).
  const [shownEnabled, setShownEnabled] = useOptimistic(enabled);

  const toggle = (next: boolean) =>
    runner.run(() => {
      setShownEnabled(next);
      return setStudentUploadsAction(next);
    });

  return (
    <div className="flex flex-col gap-2">
      <label className="flex min-h-11 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={shownEnabled}
          disabled={runner.pending}
          onChange={(e) => toggle(e.target.checked)}
          className="size-5 shrink-0 accent-brand-600"
        />
        <span className="font-medium">Students can upload their own work</span>
        {runner.pending && <Spinner className="size-4" />}
      </label>
      <p className="text-sm text-muted">
        {shownEnabled
          ? "On: each assignment gets a code and a link that students use to hand in a PDF or phone photos once you open it."
          : "Off: only teachers upload homework. Codes and links are hidden, and student pages say you aren't accepting online submissions."}
      </p>
      <p className="text-xs text-muted">Applies to every teacher on this server.</p>
      {runner.error && <Alert tone="danger">{runner.error}</Alert>}
    </div>
  );
}
