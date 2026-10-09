import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import type { WorkerStatus } from "@/lib/types";
import { plural } from "./text";

/** Problems with background grading, shown on every teacher page; renders nothing when all is well. */
export function WorkerBanner({ worker }: { worker: WorkerStatus | null }) {
  const notices = [];

  if (worker?.aiMode === "fake") {
    notices.push(
      <Alert key="fake" tone="warning" title="FAKE AI MODE — grades are not real">
        This server is running the built-in demo grader. Set AI_MODE=claude and add an API key in Settings to grade real work.
      </Alert>,
    );
  }

  if (!worker || worker.state === "stopped") {
    notices.push(
      <Alert key="stopped" tone="danger" title="Background grading isn't running">
        Answer keys and papers wait in the queue until the server is restarted.
      </Alert>,
    );
  } else if (worker.state === "paused") {
    const waiting = worker.queued > 0 ? ` ${plural(worker.queued, "job")} waiting.` : "";
    notices.push(
      <Alert key="paused" tone="warning" title="Grading is paused">
        <span className="whitespace-pre-wrap">{worker.reason ?? "The grader is waiting before trying again."}</span>
        {waiting}
        {worker.keyIssue !== null && (
          <>
            {" "}
            <Link href="/teacher/settings" className="font-medium">
              Open Settings
            </Link>
          </>
        )}
      </Alert>,
    );
  }

  if (notices.length === 0) return null;
  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 pt-4">{notices}</div>;
}
