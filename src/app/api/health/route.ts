import { getWorkerStatus } from "@/lib/jobs/queue";

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, worker: getWorkerStatus()?.state ?? "stopped" });
}
