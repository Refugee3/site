// Server-Sent Events for the teacher's live pages: the server polls its own database and pushes a snapshot only when it changed.
// Nothing here calls the AI; the browser's EventSource reconnects by itself after a dropped connection or a closed stream.

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform: keeps compression (and proxies) from buffering the stream.
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export interface LiveStreamOptions<T> {
  /** The request's signal: the stream ends when the browser goes away. */
  signal: AbortSignal;
  /** A cheap fingerprint of what the snapshot is built from; the snapshot is rebuilt when it changes. */
  probe: () => string;
  /** The snapshot, or null when its subject is gone (deleted): a "gone" event is sent and the stream ends. */
  build: () => T | null;
  /** Equal signatures mean nothing worth sending changed. */
  signature: (snapshot: T) => string;
  /** Checked every `authCheckMs`: false (logged out, session expired) ends the stream. */
  stillAllowed?: () => boolean;
  pollMs?: number;
  /** Rebuilt at least this often even when the probe stays the same (estimates, the worker's state). */
  rebuildMs?: number;
  heartbeatMs?: number;
  authCheckMs?: number;
  /** The stream ends after this long; the browser reconnects at once, so no connection lives forever. */
  maxMs?: number;
  /** How long the browser waits before reconnecting. */
  retryMs?: number;
  /** Logged when probe or build throw (the stream then ends; the browser reconnects). */
  onError?: (error: unknown) => void;
}

const encoder = new TextEncoder();

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The event stream: `retry`, then a "snapshot" event at once and again whenever it changes (polling every `pollMs`), a comment
 * line as a heartbeat, "gone" when the subject disappears. Stops polling as soon as the request is aborted or the reader cancels.
 */
export function liveEventStream<T>(o: LiveStreamOptions<T>): ReadableStream<Uint8Array> {
  const pollMs = o.pollMs ?? 1000;
  const rebuildMs = o.rebuildMs ?? 10_000;
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  const authCheckMs = o.authCheckMs ?? 30_000;
  const maxMs = o.maxMs ?? 10 * 60_000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let stop: () => void = () => undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const startedAt = Date.now();
      let lastProbe: string | null = null;
      let lastSignature: string | null = null;
      let lastBuiltAt = 0;
      let lastSentAt = startedAt;
      let lastAuthAt = startedAt;

      const send = (text: string) => {
        controller.enqueue(encoder.encode(text));
        lastSentAt = Date.now();
      };
      stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        o.signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          // already closed or errored by the runtime
        }
      };

      const tick = () => {
        if (closed) return;
        const at = Date.now();
        try {
          if (o.stillAllowed && at - lastAuthAt >= authCheckMs) {
            lastAuthAt = at;
            if (!o.stillAllowed()) {
              send(sseEvent("gone", { reason: "unauthorized" }));
              stop();
              return;
            }
          }
          const probe = o.probe();
          if (probe !== lastProbe || at - lastBuiltAt >= rebuildMs) {
            lastProbe = probe;
            lastBuiltAt = at;
            const snapshot = o.build();
            if (snapshot === null) {
              send(sseEvent("gone", { reason: "not_found" }));
              stop();
              return;
            }
            const signature = o.signature(snapshot);
            if (signature !== lastSignature) {
              lastSignature = signature;
              send(sseEvent("snapshot", snapshot));
            }
          }
          if (Date.now() - lastSentAt >= heartbeatMs) send(": keep-alive\n\n");
        } catch (e) {
          o.onError?.(e);
          stop();
          return;
        }
        if (Date.now() - startedAt >= maxMs) {
          stop();
          return;
        }
        timer = setTimeout(tick, pollMs);
      };

      if (o.signal.aborted) {
        stop();
        return;
      }
      o.signal.addEventListener("abort", stop, { once: true });
      controller.enqueue(encoder.encode(`retry: ${o.retryMs ?? 3000}\n\n`));
      tick();
    },
    cancel() {
      stop();
    },
  });
}
