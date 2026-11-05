import "server-only";
import http from "node:http";
import https from "node:https";

// A minimal client for Ollama's HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md): no SDK, plain JSON over
// fetch. The default transport is node:http behind a fetch-shaped function, because Node's global fetch gives up on a
// response whose headers take more than 5 minutes, and a non-streamed answer from a model on a CPU can take longer. Tests
// pass a fake `fetch`.

export interface FetchInit {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64 page images (PNG), for a vision model. */
  images?: string[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  /** A JSON schema the answer must follow (structured outputs). */
  format: Record<string, unknown>;
  options: { num_ctx: number; temperature: number; num_predict?: number };
  keep_alive: string;
  stream: false;
  /** false turns off a thinking model's reasoning (Qwen 3.x and the like); sent only to models that report "thinking". */
  think?: boolean;
}

export interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  /** "stop" when the answer is complete; "length" when it ran out of room. */
  done_reason?: string;
  /** Prompt tokens evaluated (absent when the prompt was cached). */
  prompt_eval_count?: number;
  /** Tokens generated. */
  eval_count?: number;
  total_duration?: number;
}

export interface OllamaTag {
  name: string;
  size?: number;
  details?: { family?: string; families?: string[] | null; parameter_size?: string };
}

/** A non-2xx answer from Ollama; `message` is its `error` field when it sent one. */
export class OllamaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OllamaHttpError";
  }
}

export interface OllamaClient {
  readonly baseUrl: string;
  chat(req: OllamaChatRequest, o?: { signal?: AbortSignal }): Promise<OllamaChatResponse>;
  /** Ollama's version string. */
  version(o?: { signal?: AbortSignal }): Promise<string | null>;
  /** The models downloaded on this computer. */
  tags(o?: { signal?: AbortSignal }): Promise<OllamaTag[]>;
  /** A model's capabilities ("completion", "vision", …); null when this Ollama doesn't report them. */
  capabilities(model: string, o?: { signal?: AbortSignal }): Promise<string[] | null>;
}

export function createOllamaClient(o: { baseUrl: string; fetch?: FetchLike }): OllamaClient {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const doFetch = o.fetch ?? nodeHttpFetch;

  async function request<T>(method: "GET" | "POST", route: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
    const res = await doFetch(`${baseUrl}${route}`, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new OllamaHttpError(res.status, errorText(text) ?? `Ollama answered HTTP ${res.status}.`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OllamaHttpError(res.status, "Ollama's answer wasn't JSON. Is the address really Ollama's?");
    }
  }

  return {
    baseUrl,
    chat: (req, opts = {}) => request<OllamaChatResponse>("POST", "/api/chat", req, opts.signal),
    async version(opts = {}) {
      const res = await request<{ version?: unknown }>("GET", "/api/version", undefined, opts.signal);
      return typeof res.version === "string" ? res.version : null;
    },
    async tags(opts = {}) {
      const res = await request<{ models?: unknown }>("GET", "/api/tags", undefined, opts.signal);
      return Array.isArray(res.models) ? res.models.filter(isTag) : [];
    },
    async capabilities(model, opts = {}) {
      const res = await request<{ capabilities?: unknown }>("POST", "/api/show", { model }, opts.signal);
      return Array.isArray(res.capabilities) ? res.capabilities.filter((c): c is string => typeof c === "string") : null;
    },
  };
}

function isTag(value: unknown): value is OllamaTag {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

function errorText(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim() !== "") return parsed.error.trim();
  } catch {
    // not JSON
  }
  const trimmed = body.trim();
  return trimmed === "" ? null : trimmed.slice(0, 300);
}

/**
 * fetch over node:http(s), without the global fetch's 5-minute limit on waiting for response headers; the caller's signal
 * is the only time limit. A connection that fails rejects like fetch does: TypeError("fetch failed") with the system
 * error (ECONNREFUSED, ENOTFOUND, …) as its cause; an abort rejects with the AbortError.
 */
export const nodeHttpFetch: FetchLike = (url, init) => new Promise<Response>((resolve, reject) => {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const req = transport.request(target, { method: init.method, headers: init.headers, signal: init.signal }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("error", (e) => reject(asFetchError(e)));
    res.on("end", () => {
      const status = res.statusCode ?? 500;
      resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), {
        status: status >= 200 && status <= 599 ? status : 500,
        headers: { "content-type": String(res.headers["content-type"] ?? "application/json") },
      }));
    });
  });
  req.on("error", (e) => reject(asFetchError(e)));
  req.end(init.body);
});

function asFetchError(e: Error): Error {
  return e.name === "AbortError" ? e : new TypeError("fetch failed", { cause: e });
}
