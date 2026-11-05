import * as z from "zod";
import type { AiUsage } from "@/lib/types";
import { AiError } from "../errors";

// The school's ChatGPT, through OpenAI's Chat Completions API (or any OpenAI-compatible address the school gives). It is the
// only AI that sees student names: it finds and reads them so the app can cover them before the grading AI sees a page.

export interface ChatGptConfig {
  apiKey: string;
  /** e.g. https://api.openai.com/v1 (no trailing slash needed). */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

export interface ChatGptImage {
  /** PNG or JPEG bytes. */
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

export interface ChatGptCall<T> {
  system: string;
  text: string;
  images: ChatGptImage[];
  schema: z.ZodType<T>;
  /** The schema's name in the request. */
  name: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatGptClient {
  readonly model: string;
  json<T>(call: ChatGptCall<T>): Promise<{ output: T; usage: AiUsage }>;
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const DEFAULT_TIMEOUT_MS = 180_000;

interface ChatResponse {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string; code?: string; type?: string };
}

export function createChatGptClient(cfg: ChatGptConfig, fetchImpl: Fetch = (url, init) => fetch(url, init)): ChatGptClient {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function json<T>(call: ChatGptCall<T>): Promise<{ output: T; usage: AiUsage }> {
    const body = JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: call.system },
        {
          role: "user",
          content: [
            { type: "text", text: call.text },
            ...call.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}`, detail: "high" },
            })),
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: call.name, schema: z.toJSONSchema(call.schema), strict: false } },
      ...(call.maxTokens ? { max_completion_tokens: call.maxTokens } : {}),
    });
    const timeout = AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}`, "api-key": cfg.apiKey },
        body,
        signal,
      });
    } catch (e) {
      if (call.signal?.aborted) throw new AiError("aborted", "The ChatGPT call was cancelled.", { retryable: false });
      if (timeout.aborted) throw new AiError("timeout", "ChatGPT took too long to answer.", { retryable: true });
      throw new AiError("connection", `Couldn't reach ChatGPT at ${cfg.baseUrl} (${e instanceof Error ? e.message : String(e)}).`, { retryable: true });
    }

    const data = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok) throw httpError(res, data, cfg);

    const choice = data.choices?.[0];
    const usage: AiUsage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    };
    const billed = { servedModel: data.model ?? cfg.model, usage };
    if (choice?.message?.refusal) {
      throw new AiError("refusal", `ChatGPT declined: ${choice.message.refusal}`, { retryable: false, billed });
    }
    if (choice?.finish_reason === "length") {
      throw new AiError("max_tokens", "ChatGPT's answer was cut off.", { retryable: true, billed });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(choice?.message?.content ?? "");
    } catch {
      throw new AiError("invalid_output", "ChatGPT returned text that is not valid JSON.", { retryable: true, billed });
    }
    const result = call.schema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new AiError("invalid_output", `ChatGPT's answer doesn't match what was asked (${issue.path.join(".") || "root"}: ${issue.message}).`, {
        retryable: true, billed,
      });
    }
    return { output: result.data, usage };
  }

  return { model: cfg.model, json };
}

function httpError(res: Response, data: ChatResponse, cfg: ChatGptConfig): AiError {
  const detail = data.error?.message ? ` ${data.error.message}` : "";
  const retryAfter = Number(res.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
  switch (true) {
    case res.status === 401 || res.status === 403:
      return new AiError("auth", `ChatGPT rejected the API key.${detail}`, {
        retryable: false, pauseWorker: true, pauseReason: "ChatGPT rejected the API key. Fix it in Settings → Student names.",
      });
    case res.status === 404:
      return new AiError("model_not_found", `ChatGPT doesn't offer the model "${cfg.model}" at this address.${detail}`, {
        retryable: false, pauseWorker: true, pauseReason: `ChatGPT has no model "${cfg.model}". Fix it in Settings → Student names.`,
      });
    case res.status === 429 && data.error?.code === "insufficient_quota":
      return new AiError("billing", `The ChatGPT account is out of credit.${detail}`, {
        retryable: false, pauseWorker: true, pauseReason: "The ChatGPT account is out of credit.",
      });
    case res.status === 429:
      return new AiError("rate_limited", `ChatGPT is busy (rate limit).${detail}`, { retryable: true, retryAfterMs });
    case res.status === 413:
      return new AiError("request_too_large", `The pages were too large for ChatGPT.${detail}`, { retryable: false });
    case res.status >= 500:
      return new AiError("server_error", `ChatGPT had a server error (${res.status}).${detail}`, { retryable: true, retryAfterMs });
    default:
      return new AiError("bad_request", `ChatGPT refused the request (${res.status}).${detail}`, { retryable: false });
  }
}
