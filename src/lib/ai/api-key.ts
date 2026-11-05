import "server-only";
import { getConfig } from "@/lib/config";
import { getAppSettings } from "@/lib/db/repos/settings";
import { sha256Hex } from "@/lib/ids";
import { decryptSecret } from "@/lib/secrets";

// The Anthropic API key: one saved in the app (encrypted at rest) wins over ANTHROPIC_API_KEY.
// The plaintext leaves this module only towards the SDK client; it is never logged.

/** `ciphertext` identifies the saved key (see markStoredApiKeyVerified) without the plaintext. */
export type ResolvedApiKey = { source: "app"; key: string; ciphertext: string } | { source: "env" };

const KEY_FORMAT = /^sk-ant-[A-Za-z0-9_-]{16,300}$/;
const MASK_PREFIX = "sk-ant-";
const FINGERPRINT_DOMAIN = "pag-agent-owner-v1:";

/** The key the grader should use: a decryptable saved key, else the server's ANTHROPIC_API_KEY, else null. */
export function resolveApiKey(): ResolvedApiKey | null {
  const { apiKeyCiphertext } = getAppSettings();
  if (apiKeyCiphertext !== null) {
    const key = decryptSecret(apiKeyCiphertext, "anthropic-api-key");
    if (key !== null) return { source: "app", key, ciphertext: apiKeyCiphertext };
    console.warn("[ai] the saved API key can't be decrypted");
  }
  return getConfig().hasApiKey ? { source: "env" } : null;
}

/** ANTHROPIC_API_KEY (trimmed) when the server has one, else null. Never logged. */
export function envApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

/**
 * Identifies the API key that owns the hosted agent's remote objects, without storing the key: the first 32 hex chars
 * of SHA-256("pag-agent-owner-v1:" + key). API keys are long random secrets, so this reveals nothing usable; it is only
 * compared for equality and never leaves the server.
 */
export function apiKeyFingerprint(key: string): string {
  return sha256Hex(FINGERPRINT_DOMAIN + key).slice(0, 32);
}

/**
 * Checks the format of a pasted key before anything is sent to Anthropic. Surrounding whitespace is
 * dropped (pasted keys often end with a newline); the character class keeps CR/LF out of the header.
 */
export function normalizeApiKeyInput(raw: string): { ok: true; key: string } | { ok: false; error: string } {
  const key = raw.trim();
  if (key === "") return { ok: false, error: "Paste your API key." };
  if (key.startsWith("sk-ant-admin")) {
    return { ok: false, error: "That's an Admin API key. Use a regular API key from Console → API keys." };
  }
  if (!KEY_FORMAT.test(key)) {
    return { ok: false, error: "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces." };
  }
  return { ok: true, key };
}

/** "sk-ant-…a1b2": enough for a teacher to recognize the key, never enough to use it. */
export function maskApiKey(key: string): string {
  return `${key.startsWith(MASK_PREFIX) ? MASK_PREFIX : ""}…${key.slice(-4)}`;
}
