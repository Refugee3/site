export async function register() {
  // Pattern from 02-guides/instrumentation.md ("Importing runtime-specific code"); Next itself skips register() during `next build`.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("@/lib/jobs/worker");
    await startWorker();
  }
}
