export async function register() {
  // Pattern from 02-guides/instrumentation.md ("Importing runtime-specific code"); Next itself skips register() during `next build`.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("@/lib/jobs/worker");
    try {
      await startWorker();
    } catch (e) {
      // `next start` only logs a failed register() and keeps serving 500s; exiting lets a supervisor see the failure.
      console.error("[startup] cannot start:", e);
      process.exit(1);
    }
  }
}
