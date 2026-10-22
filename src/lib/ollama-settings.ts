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

// ---------------------------------------------------------------------------------------------
// Speed: page image size and papers at a time (Settings → Grader → On this computer)

/** "Papers at a time": how many papers Ollama grades at once (also the most calls sent to Ollama at once). */
export const MIN_PAPERS_AT_A_TIME = 1;
export const MAX_PAPERS_AT_A_TIME = 4;
export const MIN_OLLAMA_IMAGE_MAX_EDGE = 512;
export const MAX_OLLAMA_IMAGE_MAX_EDGE = 4096;

export type OllamaModelFamily = "qwen" | "gemma" | "other";

/** The model family, from its name: "qwen2.5vl:32b" → qwen, "gemma3:27b" or "hf.co/…/gemma-3-27b-it-GGUF" → gemma. */
export function ollamaModelFamily(model: string): OllamaModelFamily {
  const name = model.toLowerCase();
  if (name.includes("qwen")) return "qwen";
  if (name.includes("gemma")) return "gemma";
  return "other";
}

/**
 * The page image size (pixels of the longer side) used when neither Settings nor OLLAMA_IMAGE_MAX_EDGE sets one:
 * - Qwen2.5-VL turns every 28×28 pixels into a token, so 1280 px (≈1,600 tokens a page) instead of 1600 (≈2,500) makes the
 *   model's reading of the pages about a third quicker, and handwriting stays readable;
 * - Gemma 3 shrinks every image to 896×896 itself, so anything larger is only rendering and transfer work;
 * - other models keep the earlier 1600.
 */
export const OLLAMA_IMAGE_EDGE_DEFAULTS: Readonly<Record<OllamaModelFamily, number>> = { qwen: 1280, gemma: 896, other: 1600 };
/** Never more for Gemma, whatever is set: it sees 896 px anyway. */
export const GEMMA_MAX_IMAGE_EDGE = 1024;

/** The page image size sent to `model`: Settings, else OLLAMA_IMAGE_MAX_EDGE, else the family's default; ≤ 1024 for Gemma. */
export function ollamaImageEdge(model: string, o: { setting: number | null; env: number | null }): number {
  const family = ollamaModelFamily(model);
  const chosen = o.setting ?? o.env ?? OLLAMA_IMAGE_EDGE_DEFAULTS[family];
  return family === "gemma" ? Math.min(chosen, GEMMA_MAX_IMAGE_EDGE) : chosen;
}

/** Settings → Grader → On this computer: null = not set (automatic image size; OLLAMA_CONCURRENCY papers at a time). */
export interface OllamaSpeedSettings {
  imageMaxEdge: number | null;
  papersAtATime: number | null;
}

export const DEFAULT_OLLAMA_SPEED: OllamaSpeedSettings = { imageMaxEdge: null, papersAtATime: null };

const IMAGE_EDGE_MESSAGE = `Enter a page image size from ${MIN_OLLAMA_IMAGE_MAX_EDGE} to ${MAX_OLLAMA_IMAGE_MAX_EDGE} pixels, or leave it `
  + "empty for automatic.";
const PAPERS_MESSAGE = `Choose from ${MIN_PAPERS_AT_A_TIME} to ${MAX_PAPERS_AT_A_TIME} papers at a time.`;

/** "" (or nothing) → null. */
function emptyAsNull(value: unknown): unknown {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") ? null : value;
}

export const OllamaImageEdgeSchema = z.preprocess(
  emptyAsNull,
  z.coerce.number(IMAGE_EDGE_MESSAGE).int(IMAGE_EDGE_MESSAGE).min(MIN_OLLAMA_IMAGE_MAX_EDGE, IMAGE_EDGE_MESSAGE)
    .max(MAX_OLLAMA_IMAGE_MAX_EDGE, IMAGE_EDGE_MESSAGE).nullable(),
);

export const PapersAtATimeSchema = z.preprocess(
  emptyAsNull,
  z.coerce.number(PAPERS_MESSAGE).int(PAPERS_MESSAGE).min(MIN_PAPERS_AT_A_TIME, PAPERS_MESSAGE).max(MAX_PAPERS_AT_A_TIME, PAPERS_MESSAGE)
    .nullable(),
);

export const OllamaSpeedSchema = z.object({ imageMaxEdge: OllamaImageEdgeSchema, papersAtATime: PapersAtATimeSchema });

/** The "Papers at a time" hint in Settings. */
export const PAPERS_AT_A_TIME_HINT = "2 works well with gemma3:27b on a 24 GB card. Also set OLLAMA_NUM_PARALLEL to the same number "
  + "(setx OLLAMA_NUM_PARALLEL 2) and restart Ollama. Use 1 for qwen2.5vl:32b.";

/** The "Page image size" hint in Settings, for the model typed there. */
export function imageEdgeHint(model: string, envImageMaxEdge: number | null): string {
  const auto = ollamaImageEdge(model, { setting: null, env: envImageMaxEdge });
  const source = envImageMaxEdge === null ? "" : " (OLLAMA_IMAGE_MAX_EDGE on the server)";
  return `Pixels of each page image's longer side. Empty = automatic: ${auto} px for ${model.trim() || "this model"}${source}. `
    + `Qwen models: ${OLLAMA_IMAGE_EDGE_DEFAULTS.qwen} reads handwriting well and is about a third faster than 1600. Gemma models `
    + `shrink every image to 896 px themselves, so at most ${GEMMA_MAX_IMAGE_EDGE} is sent. Larger reads tiny writing better but `
    + "is slower.";
}
