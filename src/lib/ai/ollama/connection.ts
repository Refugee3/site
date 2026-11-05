import "server-only";
import {
  type OllamaConnectionResult, type OllamaModelInfo, type OllamaSettings, pullCommand, visionFromName,
} from "@/lib/ollama-settings";
import { AiError } from "../errors";
import { createOllamaClient, type FetchLike, type OllamaClient } from "./client";
import { classifyOllamaError } from "./errors";

// Settings → Grader → "Test connection": is Ollama reachable at the address, which models are downloaded, which of them can
// read images, and what to do next. Never throws.

const CHECK_TIMEOUT_MS = 5_000;

export async function testOllamaConnection(
  settings: Pick<OllamaSettings, "baseUrl" | "model">,
  o: { fetch?: FetchLike; client?: OllamaClient } = {},
): Promise<OllamaConnectionResult> {
  const client = o.client ?? createOllamaClient({ baseUrl: settings.baseUrl, fetch: o.fetch });
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  let version: string | null;
  let models: OllamaModelInfo[];
  try {
    version = await client.version({ signal: timeout });
    const tags = await client.tags({ signal: timeout });
    models = await Promise.all(tags.map(async (tag): Promise<OllamaModelInfo> => ({
      name: tag.name,
      size: typeof tag.size === "number" ? tag.size : null,
      vision: await visionOf(client, tag.name),
      parameterSize: tag.details?.parameter_size ?? null,
    })));
  } catch (e) {
    const err = classifyOllamaError(e, {
      baseUrl: client.baseUrl, model: settings.model, numCtx: 0, timeoutMs: CHECK_TIMEOUT_MS, aborted: false, timedOut: timeout.aborted,
    });
    return { ok: false, error: describe(err, client.baseUrl), fix: fixFor(err, client.baseUrl) };
  }
  models.sort((a, b) => Number(b.vision === true) - Number(a.vision === true) || a.name.localeCompare(b.name));
  const chosen = models.find((m) => sameModel(m.name, settings.model)) ?? null;
  return {
    ok: true,
    version,
    models,
    modelInstalled: chosen !== null,
    fix: chosen === null
      ? `The model ${settings.model} isn't downloaded yet. Run: ${pullCommand(settings.model)}`
      : chosen.vision === false
        ? `The model ${settings.model} can't read page images. Choose a vision model, such as qwen2.5vl:7b.`
        : null,
  };
}

/** "qwen2.5vl" is "qwen2.5vl:latest". */
export function sameModel(a: string, b: string): boolean {
  const full = (name: string) => (name.includes(":") ? name : `${name}:latest`).toLowerCase();
  return full(a) === full(b);
}

/** From Ollama's capabilities when it reports them (0.6.4 and later), else a guess from the name. */
async function visionOf(client: OllamaClient, model: string): Promise<boolean | null> {
  try {
    const capabilities = await client.capabilities(model, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (capabilities !== null) return capabilities.includes("vision");
  } catch {
    // An older Ollama, or a model it can't describe: fall back to the name.
  }
  return visionFromName(model);
}

function describe(err: AiError, baseUrl: string): string {
  switch (err.code) {
    case "connection":
      return `Nothing answered at ${baseUrl}.`;
    case "timeout":
      return `${baseUrl} didn't answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`;
    default:
      return `${baseUrl} answered, but not like Ollama: ${err.message}`;
  }
}

function fixFor(err: AiError, baseUrl: string): string {
  if (err.code === "connection" && err.message.startsWith("Ollama isn't running")) {
    return `Ollama isn't running at ${baseUrl}. Start Ollama (open the Ollama app from the Start menu, or run "ollama serve"), `
      + "then test again.";
  }
  if (err.code === "connection" || err.code === "timeout") {
    return `Start Ollama (open the Ollama app, or run "ollama serve"), then test again. Ollama usually listens on `
      + `http://localhost:11434; the address here is ${baseUrl}.`;
  }
  return "Check that the address is Ollama's (usually http://localhost:11434) and that Ollama is up to date.";
}
