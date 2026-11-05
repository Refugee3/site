import { AiError } from "../errors";
import type { OllamaClient } from "./client";

// Several computers running Ollama, used as one: each call goes to the first computer with a free slot ("papers at a time"
// each), so two GPUs grade about twice as many papers. A computer that can't be reached (or lacks the model) is set aside for
// a while (markDown) and its calls go to the others; when every computer is set aside, they are all tried again, so the
// error that pauses grading is still reported.

/** How long a computer that couldn't be reached is skipped. */
export const HOST_DOWN_MS = 2 * 60_000;

export interface HostLease {
  client: OllamaClient;
  /** Frees the slot (idempotent). */
  release(): void;
  /** Skips this computer for HOST_DOWN_MS. */
  markDown(): void;
}

export interface HostPool {
  /** Number of computers. */
  readonly size: number;
  /** A free slot on a usable computer, waiting for one when all are busy. Rejects with AiError("aborted") on `signal`. */
  acquire(signal?: AbortSignal): Promise<HostLease>;
  /** Another computer than `lease`'s that isn't set aside (a call can move there). */
  hasOther(lease: HostLease): boolean;
  /** Free slots on the computers that aren't set aside. */
  free(): number;
}

interface Host {
  client: OllamaClient;
  active: number;
  downUntil: number;
}

export function createHostPool(clients: OllamaClient[], perHost: number, now: () => number = Date.now): HostPool {
  if (clients.length === 0) throw new Error("createHostPool needs at least one Ollama client");
  const slots = Math.max(1, Math.floor(perHost));
  const hosts: Host[] = clients.map((client) => ({ client, active: 0, downUntil: 0 }));
  const waiting: Array<() => boolean> = [];

  const up = (h: Host) => h.downUntil <= now();

  /** The first host with a free slot among the usable ones (all of them when none is usable). */
  function pick(): Host | null {
    const usable = hosts.some(up) ? hosts.filter(up) : hosts;
    return usable.find((h) => h.active < slots) ?? null;
  }

  function lease(host: Host): HostLease {
    host.active++;
    let released = false;
    return {
      client: host.client,
      release() {
        if (released) return;
        released = true;
        host.active--;
        // Wake waiters in order until one gets a slot.
        for (let i = 0; i < waiting.length; i++) {
          if (waiting[i]()) {
            waiting.splice(i, 1);
            break;
          }
        }
      },
      markDown() {
        host.downUntil = now() + HOST_DOWN_MS;
      },
    };
  }

  return {
    size: hosts.length,
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new AiError("aborted", "The call to Ollama was stopped.", { retryable: true }));
      const host = pick();
      if (host) return Promise.resolve(lease(host));
      return new Promise<HostLease>((resolve, reject) => {
        const tryTake = () => {
          const free = pick();
          if (!free) return false;
          signal?.removeEventListener("abort", onAbort);
          resolve(lease(free));
          return true;
        };
        const onAbort = () => {
          const at = waiting.indexOf(tryTake);
          if (at !== -1) waiting.splice(at, 1);
          reject(new AiError("aborted", "The call to Ollama was stopped.", { retryable: true }));
        };
        waiting.push(tryTake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    hasOther(current) {
      return hosts.some((h) => h.client !== current.client && up(h));
    },
    free() {
      const usable = hosts.some(up) ? hosts.filter(up) : hosts;
      return usable.reduce((n, h) => n + Math.max(0, slots - h.active), 0);
    },
  };
}
