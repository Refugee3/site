import { pullCommand } from "@/lib/ollama-settings";
import { AiError } from "../errors";
import { OllamaHttpError } from "./client";

// Ollama failures as AiErrors, so the job layer retries, pauses or fails exactly as it does for Claude. Problems every paper
// would hit (Ollama not running, the model not downloaded or too big for this computer) pause grading with a fix the
// teacher can act on; a slow or interrupted call is retried.

export interface OllamaErrorContext {
  baseUrl: string;
  model: string;
  numCtx: number;
  /** The call's own time limit (OLLAMA_TIMEOUT_MS) ran out. */
  timedOut: boolean;
  /** The job's signal aborted the call (job timeout, or the worker stopping). */
  aborted: boolean;
  timeoutMs: number;
}

const UNREACHABLE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);

export function ollamaNotRunning(baseUrl: string): string {
  return `Ollama isn't running at ${baseUrl} — start Ollama (open the Ollama app, or run "ollama serve"); grading continues `
    + "within 5 minutes, or at once when you click Test connection in Settings → Grader.";
}

export function ollamaUnreachable(baseUrl: string): string {
  return `Ollama can't be reached at ${baseUrl}. Check the address in Settings → Grader, and that Ollama is running.`;
}

export function modelNotDownloaded(model: string): string {
  return `The model ${model} isn't downloaded in Ollama. Run: ${pullCommand(model)}`;
}

export function classifyOllamaError(e: unknown, ctx: OllamaErrorContext): AiError {
  if (e instanceof AiError) return e;
  if (ctx.aborted) return new AiError("aborted", "The call to Ollama was stopped.", { retryable: true });
  if (ctx.timedOut) {
    const minutes = Math.round(ctx.timeoutMs / 60_000);
    return new AiError("timeout", `Ollama didn't answer within ${minutes} min. A smaller model or a GPU makes it faster.`, { retryable: true });
  }
  if (e instanceof Error && e.name === "AbortError") return new AiError("aborted", "The call to Ollama was stopped.", { retryable: true });
  if (e instanceof OllamaHttpError) return classifyHttp(e, ctx);
  const code = systemErrorCode(e);
  if (code === "ECONNREFUSED" || code === "EADDRNOTAVAIL") {
    const reason = ollamaNotRunning(ctx.baseUrl);
    return new AiError("connection", reason, { retryable: true, pauseWorker: true, pauseReason: reason });
  }
  if (code !== null && UNREACHABLE_CODES.has(code)) {
    const reason = ollamaUnreachable(ctx.baseUrl);
    return new AiError("connection", reason, { retryable: true, pauseWorker: true, pauseReason: reason });
  }
  if (e instanceof TypeError) {
    // ECONNRESET and the like: Ollama closed the connection mid-answer (it may have crashed or run out of memory).
    return new AiError("connection", `The connection to Ollama broke${code ? ` (${code})` : ""}.`, { retryable: true });
  }
  return new AiError("unknown", e instanceof Error ? e.message : String(e), { retryable: true });
}

function classifyHttp(e: OllamaHttpError, ctx: OllamaErrorContext): AiError {
  const message = e.message;
  if (e.status === 404 && /not found|pull/i.test(message)) {
    const reason = modelNotDownloaded(ctx.model);
    return new AiError("model_not_found", reason, { retryable: false, pauseWorker: true, pauseReason: reason });
  }
  if (/does not support (images|vision)|vision|image input/i.test(message) && e.status < 500) {
    const reason = `The model ${ctx.model} can't read page images. Choose a vision model, such as qwen2.5vl:7b, in Settings → Grader.`;
    return new AiError("bad_request", reason, { retryable: false, pauseWorker: true, pauseReason: reason });
  }
  if (/context (length|window)|exceeds|too long/i.test(message)) {
    return new AiError("request_too_large", `The pages don't fit the model's context size (${ctx.numCtx}). Raise the context size in `
      + "Settings → Grader, or lower OLLAMA_PAGES_PER_CALL.", { retryable: false });
  }
  if (/memory|out of memory|cuda|insufficient|unable to allocate|llama runner/i.test(message)) {
    const reason = `Ollama couldn't run ${ctx.model} on this computer: ${message}. Choose a smaller model in Settings → Grader, `
      + "or close other programs.";
    return new AiError("server_error", reason, { retryable: false, pauseWorker: true, pauseReason: reason });
  }
  if (e.status === 503 || e.status === 429) return new AiError("overloaded", `Ollama is busy: ${message}`, { retryable: true });
  if (e.status >= 500) return new AiError("server_error", `Ollama failed: ${message}`, { retryable: true });
  if (e.status === 400 || e.status === 422) return new AiError("bad_request", `Ollama refused the request: ${message}`, { retryable: false });
  return new AiError("unknown", `Ollama answered HTTP ${e.status}: ${message}`, { retryable: false });
}

/** ECONNREFUSED and friends, from fetch's TypeError("fetch failed", { cause }) or a raw system error. */
function systemErrorCode(e: unknown): string | null {
  for (let current: unknown = e, depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return code;
    // AggregateError (both IPv4 and IPv6 refused): the first error's code.
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      current = errors[0];
      continue;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
