import { describe, expect, it } from "vitest";
import * as z from "zod";
import { AiError } from "../errors";
import { createChatGptClient, type Fetch } from "./client";

function fakeFetch(...replies: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const reply = replies.shift()!;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  };
  return { sent, fetch };
}

const ok = (content: unknown) => ({
  body: { model: "gpt-x", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 120, completion_tokens: 30 } },
});
const call = { system: "sys", text: "task", images: [{ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" as const }], schema: z.object({ ok: z.boolean() }), name: "test" };

describe("the ChatGPT client", () => {
  it("sends the pages as images with a JSON schema and reads the answer", async () => {
    const api = fakeFetch(ok({ ok: true }));
    const client = createChatGptClient({ apiKey: "sk-test", baseUrl: "https://api.example.edu/v1/", model: "gpt-x" }, api.fetch);
    const { output, usage } = await client.json(call);

    expect(output).toEqual({ ok: true });
    expect(usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(api.sent[0].url).toBe("https://api.example.edu/v1/chat/completions");
    expect(api.sent[0].headers.authorization).toBe("Bearer sk-test");
    const body = api.sent[0].body as { model: string; messages: Array<{ content: unknown }>; response_format: { type: string } };
    expect(body.model).toBe("gpt-x");
    expect(body.response_format.type).toBe("json_schema");
    expect(JSON.stringify(body.messages[1].content)).toContain("data:image/png;base64,AQID");
  });

  it("classifies failures so the worker retries, pauses or gives up", async () => {
    const err = async (reply: Parameters<typeof fakeFetch>[0]) => {
      const client = createChatGptClient({ apiKey: "k", baseUrl: "https://x/v1", model: "m" }, fakeFetch(reply).fetch);
      return client.json(call).then(() => null, (e: unknown) => e as AiError);
    };
    expect(await err({ status: 401, body: { error: { message: "bad key" } } })).toMatchObject({ code: "auth", o: { pauseWorker: true } });
    expect(await err({ status: 404, body: {} })).toMatchObject({ code: "model_not_found" });
    expect(await err({ status: 429, body: {}, headers: { "retry-after": "7" } })).toMatchObject({ code: "rate_limited", o: { retryable: true, retryAfterMs: 7000 } });
    expect(await err({ status: 503, body: {} })).toMatchObject({ code: "server_error", o: { retryable: true } });
    expect(await err(ok({ nope: 1 }))).toMatchObject({ code: "invalid_output" });
    expect(await err({ body: { choices: [{ message: { content: "not json" } }] } })).toMatchObject({ code: "invalid_output" });
    expect(await err({ body: { choices: [{ message: { refusal: "no" } }] } })).toMatchObject({ code: "refusal" });
  });
});
