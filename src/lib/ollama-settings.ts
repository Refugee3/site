import * as z from "zod";

// Settings → Grader → "On this computer (Ollama)": the defaults, limits and validation shared by the server and the
// Settings page (client-safe: no server imports).

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
/** Reads handwriting well for its size and runs on a GPU with about 8 GB of memory (≈ 6 GB download). */
export const DEFAULT_OLLAMA_MODEL = "qwen2.5vl:7b";
/** Tokens the model sees at once (prompt, page images and answer). Each page image is roughly 1,000–2,500 tokens. */
export const DEFAULT_OLLAMA_NUM_CTX = 16_384;
export const MIN_OLLAMA_NUM_CTX = 4_096;
export const MAX_OLLAMA_NUM_CTX = 131_072;

/** Model names in the usage ledger start with this, so a local call is priced at $0 (views.estimateCostUsd). */
export const OLLAMA_MODEL_PREFIX = "ollama:";

/** Suggested models by GPU memory, shown in Settings and the README. */
export const RECOMMENDED_OLLAMA_MODELS: ReadonlyArray<{ name: string; note: string }> = [
  { name: "qwen2.5vl:7b", note: "Recommended — about 8 GB of GPU memory" },
  { name: "gemma3:12b", note: "About 12 GB of GPU memory" },
  { name: "qwen2.5vl:32b", note: "Most accurate — about 24 GB of GPU memory" },
];

export interface OllamaSettings {
  baseUrl: string;
  model: string;
  numCtx: number;
}

export const DEFAULT_OLLAMA_SETTINGS: OllamaSettings = {
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  model: DEFAULT_OLLAMA_MODEL,
  numCtx: DEFAULT_OLLAMA_NUM_CTX,
};

const BASE_URL_MESSAGE = "Enter the address Ollama listens on, such as http://localhost:11434.";
const MODEL_MESSAGE = "Enter a model name such as qwen2.5vl:7b (letters, digits and . _ - : /).";
const NUM_CTX_MESSAGE = `Enter a context size from ${MIN_OLLAMA_NUM_CTX} to ${MAX_OLLAMA_NUM_CTX}.`;

/** An http(s) origin with an optional path prefix (for a proxy), without credentials, query or fragment; no trailing slash. */
export const OllamaBaseUrlSchema = z.string(BASE_URL_MESSAGE).trim().max(200, BASE_URL_MESSAGE).transform((value, ctx) => {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "") {
    ctx.addIssue({ code: "custom", message: BASE_URL_MESSAGE });
    return z.NEVER;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
});

/** Ollama model names: "qwen2.5vl:7b", "library/gemma3:12b", "hf.co/user/model:Q4_K_M". */
export const OllamaModelSchema = z.string(MODEL_MESSAGE).trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, MODEL_MESSAGE);

export const OllamaNumCtxSchema = z.coerce.number(NUM_CTX_MESSAGE).int(NUM_CTX_MESSAGE)
  .min(MIN_OLLAMA_NUM_CTX, NUM_CTX_MESSAGE).max(MAX_OLLAMA_NUM_CTX, NUM_CTX_MESSAGE);

export const OllamaSettingsSchema = z.object({
  baseUrl: OllamaBaseUrlSchema,
  model: OllamaModelSchema,
  numCtx: OllamaNumCtxSchema,
});

/** What "Test connection" found; `fix` is a teacher-readable next step when Ollama can't be used yet. */
export type OllamaConnectionResult =
  | {
    ok: true;
    version: string | null;
    models: OllamaModelInfo[];
    /** Whether the chosen model is among `models`. */
    modelInstalled: boolean;
    /** Set when the chosen model is installed but can't read images, or isn't installed. */
    fix: string | null;
  }
  | { ok: false; error: string; fix: string };

export interface OllamaModelInfo {
  name: string;
  /** Bytes on disk. */
  size: number | null;
  /** true/false when Ollama reports the model's capabilities; null when it doesn't (older Ollama) and the name says nothing. */
  vision: boolean | null;
  parameterSize: string | null;
}

/** The command that downloads a model. */
export function pullCommand(model: string): string {
  return `ollama pull ${model}`;
}

/** Families that read images, for an Ollama too old to report capabilities. */
const VISION_NAME = /(^|[/:._-])(llava|bakllava|moondream|minicpm-v|qwen2(\.5)?-?vl|qwen3-?vl|gemma3|gemma3n|llama3\.2-vision|llama4|mistral-small3\.[12]|granite3\.2-vision|granite-vision|internvl|pixtral|llama-vision)/i;

/** A guess from the model's name: true for known vision families, else null (unknown). */
export function visionFromName(name: string): boolean | null {
  return VISION_NAME.test(name) ? true : null;
}
