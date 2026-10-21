import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOllamaClient, type FetchInit, nodeHttpFetch, OllamaHttpError } from "./client";
import { sameModel, testOllamaConnection } from "./connection";
import { classifyOllamaError } from "./errors";

// "Test connection" against a fake fetch, and the node:http transport against a server on this machine (no network).

function fakeApi(routes: Record<string, (body: unknown) => Response>) {
  const calls: string[] = [];
  const fetch = async (url: string, init: FetchInit): Promise<Response> => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    const route = routes[path];
    if (!route) return Response.json({ error: "404 page not found" }, { status: 404 });
    return route(init.body === undefined ? null : JSON.parse(init.body));
  };
  return { calls, fetch };
}

const TAGS = {
  models: [
    { name: "llama3.2:3b", size: 2_000_000_000, details: { parameter_size: "3.2B" } },
    { name: "qwen2.5vl:7b", size: 6_000_000_000, details: { parameter_size: "8.3B" } },
    { name: "llava:7b", size: 4_700_000_000 },
  ],
};

describe("testOllamaConnection", () => {
  it("lists the downloaded models, vision models first, from Ollama's capabilities (falling back to the name)", async () => {
    const api = fakeApi({
      "/api/version": () => Response.json({ version: "0.40.7" }),
      "/api/tags": () => Response.json(TAGS),
      "/api/show": (body) => {
        const { model } = body as { model: string };
        if (model === "llava:7b") return Response.json({ details: {} }); // an Ollama that doesn't report capabilities
        return Response.json({ capabilities: model.startsWith("qwen") ? ["completion", "vision"] : ["completion", "tools"] });
      },
    });
    const result = await testOllamaConnection({ baseUrl: "http://localhost:11434", model: "qwen2.5vl:7b" }, { fetch: api.fetch });
    expect(result).toEqual({
      ok: true,
      version: "0.40.7",
      models: [
        { name: "llava:7b", size: 4_700_000_000, vision: true, parameterSize: null },
        { name: "qwen2.5vl:7b", size: 6_000_000_000, vision: true, parameterSize: "8.3B" },
        { name: "llama3.2:3b", size: 2_000_000_000, vision: false, parameterSize: "3.2B" },
      ],
      modelInstalled: true,
      fix: null,
    });
  });

  it("says to pull the chosen model when it isn't downloaded", async () => {
    const api = fakeApi({
      "/api/version": () => Response.json({ version: "0.40.7" }),
      "/api/tags": () => Response.json({ models: [] }),
    });
    expect(await testOllamaConnection({ baseUrl: "http://localhost:11434", model: "gemma3:12b" }, { fetch: api.fetch })).toEqual({
      ok: true, version: "0.40.7", models: [], modelInstalled: false,
      fix: "The model gemma3:12b isn't downloaded yet. Run: ollama pull gemma3:12b",
    });
  });

  it("says when the chosen model can't read images", async () => {
    const api = fakeApi({
      "/api/version": () => Response.json({ version: "0.40.7" }),
      "/api/tags": () => Response.json(TAGS),
      "/api/show": () => Response.json({ capabilities: ["completion"] }),
    });
    const result = await testOllamaConnection({ baseUrl: "http://localhost:11434", model: "llama3.2:3b" }, { fetch: api.fetch });
    expect(result).toMatchObject({ ok: true, modelInstalled: true, fix: expect.stringContaining("can't read page images") });
  });

  it("says to start Ollama when nothing listens at the address", async () => {
    const refused = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    };
    expect(await testOllamaConnection({ baseUrl: "http://localhost:11434", model: "qwen2.5vl:7b" }, { fetch: refused })).toEqual({
      ok: false,
      error: "Nothing answered at http://localhost:11434.",
      fix: "Ollama isn't running at http://localhost:11434. Start Ollama (open the Ollama app from the Start menu, or run \"ollama serve\"), "
        + "then test again.",
    });
  });

  it("says when the address answers but isn't Ollama", async () => {
    const api = fakeApi({ "/api/version": () => new Response("<html>router login</html>", { status: 200 }) });
    const result = await testOllamaConnection({ baseUrl: "http://192.168.1.1", model: "qwen2.5vl:7b" }, { fetch: api.fetch });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not like Ollama") });
  });

  it("matches a model given without a tag to its :latest", () => {
    expect(sameModel("llava", "llava:latest")).toBe(true);
    expect(sameModel("qwen2.5vl:7b", "qwen2.5vl:3b")).toBe(false);
  });
});

describe("nodeHttpFetch (the default transport)", () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("posts JSON and reads the answer, and Ollama's errors become OllamaHttpError", async () => {
    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    const baseUrl = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body });
        if (req.url === "/api/show") {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "model 'x' not found" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "0.40.7" }));
      });
    });
    const client = createOllamaClient({ baseUrl: `${baseUrl}/` });
    expect(client.baseUrl).toBe(baseUrl);
    expect(await client.version()).toBe("0.40.7");
    const err = await client.capabilities("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OllamaHttpError);
    expect(err).toMatchObject({ status: 404, message: "model 'x' not found" });
    expect(seen).toEqual([{ method: "GET", url: "/api/version", body: "" }, { method: "POST", url: "/api/show", body: "{\"model\":\"x\"}" }]);
  });

  it("rejects like fetch when nothing listens, which reads as \"Ollama isn't running\"", async () => {
    const baseUrl = await listen(() => undefined);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const e = await nodeHttpFetch(`${baseUrl}/api/version`, { method: "GET" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(TypeError);
    const err = classifyOllamaError(e, {
      baseUrl, model: "m", numCtx: 16_384, timedOut: false, aborted: false, timeoutMs: 1000,
    });
    expect(err).toMatchObject({ code: "connection", o: { pauseWorker: true } });
    expect(err.message).toContain(`Ollama isn't running at ${baseUrl}`);
  });

  it("stops waiting when its signal aborts", async () => {
    const baseUrl = await listen(() => undefined); // never answers
    const e = await nodeHttpFetch(`${baseUrl}/api/chat`, { method: "POST", body: "{}", signal: AbortSignal.timeout(20) })
      .catch((err: unknown) => err);
    expect(e).toMatchObject({ name: "AbortError" });
    server!.closeAllConnections();
  });
});
