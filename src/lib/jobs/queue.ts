import { getConfig } from "@/lib/config";
import { enqueueJob } from "@/lib/db/repos/jobs";
import type { WorkerStatus } from "@/lib/types";

// Enqueueing and worker lookups live here rather than in worker.ts so that services and views can
// reach the worker without importing it (worker → handlers → services would otherwise form a cycle).

/** Lower runs first: a teacher is watching key extraction; students before regrades before scanned copies. */
export const PRIORITY = { extractKey: 0, student: 10, regrade: 15, teacher: 20 } as const;

/** What queue.ts needs from the worker that startWorker() stores in the process-wide slot (§4). */
interface WorkerHandle {
  kick(): void;
  status(): WorkerStatus;
}

const WORKER_SLOT = Symbol.for("pag.worker");
const slots = globalThis as unknown as Record<symbol, WorkerHandle | undefined>;

/** Safe inside a caller's tx(): the job row joins that transaction and the kick only schedules a tick. */
export function enqueueExtractKey(assignmentId: string): void {
  enqueueJob({
    kind: "extract_key",
    targetId: assignmentId,
    assignmentId,
    priority: PRIORITY.extractKey,
    maxAttempts: getConfig().jobMaxAttempts,
  });
  kickWorker();
}

/** Safe inside a caller's tx(), like enqueueExtractKey. */
export function enqueueGrade(submissionId: string, assignmentId: string, priority: number): void {
  enqueueJob({
    kind: "grade_submission",
    targetId: submissionId,
    assignmentId,
    priority,
    maxAttempts: getConfig().jobMaxAttempts,
  });
  kickWorker();
}

/** Asks the running worker to look for work soon; a no-op when no worker runs in this process. */
export function kickWorker(): void {
  slots[WORKER_SLOT]?.kick();
}

export function getWorkerStatus(): WorkerStatus | null {
  return slots[WORKER_SLOT]?.status() ?? null;
}
