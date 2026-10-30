import "server-only";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pdfJsAssets } from "@/lib/ai/ollama/render";
import { getConfig } from "@/lib/config";

// PDF pages rendered in worker threads (workers/render-pages.mjs), so papers graded at once, and a class scan's pages, render
// on several cores: decoding a scanned page takes seconds of CPU. The worker script is plain JavaScript loaded by path, never
// bundled. Each worker opens a document once (its bytes are sent with its first page there) and keeps it until close().
// If the workers can't start here, pages render in-process as before.

export type RenderRequest =
  | { op: "gray"; page: number; dpi: number }
  | { op: "gray"; page: number; widthPx: number }
  | { op: "png"; page: number; maxEdge: number };

/** Gray pixels (op "gray") or PNG bytes (op "png"). */
export interface RenderResult {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The pool can't render (its workers don't start here): render in-process instead. */
export class RenderPoolUnavailable extends Error {}

/** The worker couldn't open the document, or died while rendering it. */
export class RenderFailed extends Error {}

export interface PooledPdf {
  render(req: RenderRequest): Promise<RenderResult>;
  /** Frees the document in every worker; renders still queued for it are refused. */
  close(): void;
}

/** Threads to render with: RENDER_THREADS, else one per core but one (the main thread's), at most 8; 0 = in-process. */
export function renderThreads(): number {
  const configured = getConfig().renderThreads;
  if (configured !== null) return configured;
  const cores = os.availableParallelism();
  return cores <= 1 ? 0 : Math.min(8, cores - 1);
}

const SLOT = Symbol.for("pag.render-pool");

/** A document whose pages render in the pool, or null when pages render in-process. */
export function pooledPdf(bytes: Uint8Array): PooledPdf | null {
  const size = renderThreads();
  if (size === 0) return null;
  const slot = globalThis as unknown as Record<symbol, RenderPool | undefined>;
  const pool = (slot[SLOT] ??= new RenderPool());
  pool.size = size;
  return pool.broken ? null : pool.open(bytes);
}

interface Doc {
  id: number;
  bytes: Uint8Array;
  closed: boolean;
}

interface Job {
  doc: Doc;
  req: RenderRequest;
  resolve: (r: RenderResult) => void;
  reject: (e: Error) => void;
}

interface Thread {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  /** Documents this worker has open. */
  docs: Set<number>;
}

type Reply =
  | { ready: true }
  | { ok: true; width: number; height: number; data: Uint8Array }
  | { ok: false; message: string; unreadable: boolean };

class RenderPool {
  size = 1;
  broken = false;
  private threads: Thread[] = [];
  private queue: Job[] = [];
  private nextId = 1;

  open(bytes: Uint8Array): PooledPdf {
    const doc: Doc = { id: this.nextId++, bytes, closed: false };
    return {
      render: (req) => new Promise<RenderResult>((resolve, reject) => {
        if (doc.closed) return reject(new Error("The PDF was closed."));
        if (this.broken) return reject(new RenderPoolUnavailable());
        this.queue.push({ doc, req, resolve, reject });
        this.pump();
      }),
      close: () => this.close(doc),
    };
  }

  private close(doc: Doc): void {
    doc.closed = true;
    this.queue = this.queue.filter((job) => {
      if (job.doc !== doc) return true;
      job.reject(new Error("The PDF was closed."));
      return false;
    });
    for (const t of this.threads) {
      if (t.docs.delete(doc.id)) t.worker.postMessage({ op: "close", doc: doc.id });
    }
  }

  /** Hands queued renders to idle workers (one that has the document open first), starting workers up to `size`. */
  private pump(): void {
    while (this.queue.length > 0 && !this.broken) {
      const job = this.queue[0];
      const idle = this.threads.filter((t) => t.job === null);
      const thread = idle.find((t) => t.docs.has(job.doc.id)) ?? idle[0] ?? (this.threads.length < this.size ? this.spawn() : null);
      if (!thread) return;
      this.queue.shift();
      const first = !thread.docs.has(job.doc.id);
      // Posting a view into a larger buffer would copy the whole buffer.
      const { bytes } = job.doc;
      if (first && bytes.byteLength !== bytes.buffer.byteLength) job.doc.bytes = bytes.slice();
      thread.docs.add(job.doc.id);
      thread.job = job;
      // Referenced while it works, so the process waits for the page; idle workers never keep it alive.
      thread.worker.ref();
      thread.worker.postMessage({ ...job.req, doc: job.doc.id, bytes: first ? job.doc.bytes : undefined });
    }
  }

  private spawn(): Thread | null {
    let worker: Worker;
    try {
      const file = path.join(/*turbopackIgnore: true*/ process.cwd(), "workers", "render-pages.mjs");
      worker = new Worker(/*turbopackIgnore: true*/ file, { workerData: { assets: pdfJsAssets() } });
    } catch (e) {
      this.fail(e);
      return null;
    }
    const thread: Thread = { worker, ready: false, job: null, docs: new Set() };
    worker.unref();
    worker.on("message", (m: Reply) => {
      if ("ready" in m) {
        thread.ready = true;
        return;
      }
      const job = thread.job;
      thread.job = null;
      worker.unref();
      if (job) {
        if (m.ok) job.resolve({ width: m.width, height: m.height, data: m.data });
        else job.reject(m.unreadable ? new RenderFailed(m.message) : new Error(m.message));
        // The worker dropped a document it couldn't open: send the bytes again next time.
        if (!m.ok && m.unreadable) thread.docs.delete(job.doc.id);
      }
      this.pump();
    });
    let error: unknown = null;
    worker.on("error", (e) => {
      error = e;
    });
    worker.on("exit", () => {
      this.threads = this.threads.filter((t) => t !== thread);
      const job = thread.job;
      thread.job = null;
      if (!thread.ready) {
        // It never loaded (a missing file or package): every render, this one included, goes in-process.
        if (job) this.queue.unshift(job);
        this.fail(error);
        return;
      }
      if (error) console.error("A page-rendering worker stopped:", error);
      job?.reject(new RenderFailed("The page-rendering worker stopped."));
      this.pump();
    });
    this.threads.push(thread);
    return thread;
  }

  private fail(e: unknown): void {
    if (!this.broken) console.error("Page-rendering workers didn't start; rendering in-process instead:", e);
    this.broken = true;
    for (const job of this.queue) job.reject(new RenderPoolUnavailable());
    this.queue = [];
  }
}

/**
 * Returns `take(i)` for items 1..count taken in increasing order: taking item i starts items up to i + `ahead` (with
 * `start`), so they render while the caller works on item i. `ahead` 0: each item starts when taken.
 */
export function readAhead<T>(count: number, ahead: number, start: (i: number) => Promise<T>): (i: number) => Promise<T> {
  const started = new Map<number, Promise<T>>();
  let next = 1;
  return (i) => {
    for (; next <= Math.max(i, Math.min(count, i + ahead)); next++) {
      const p = start(next);
      // Rejections surface when the item is taken; one never taken (an abort) is dropped.
      p.catch(() => undefined);
      started.set(next, p);
    }
    const p = started.get(i)!;
    started.delete(i);
    return p;
  };
}
