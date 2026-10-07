import "server-only";
import { getConfig } from "@/lib/config";
import { getAppSettings } from "@/lib/db/repos/settings";
import { decryptSecret } from "@/lib/secrets";

// The Anthropic API key: one saved in the app (encrypted at rest) wins over ANTHROPIC_API_KEY.
// The plaintext leaves this module only towards the SDK client; it is never logged.

export type ResolvedApiKey = { source: "app"; key: string } | { source: "env" };

const KEY_FORMAT = /^sk-ant-[A-Za-z0-9_-]{16,300}$/;
const MASK_PREFIX = "sk-ant-";

/** The key the grader should use: a decryptable saved key, else the server's ANTHROPIC_API_KEY, else null. */
export function resolveApiKey(): ResolvedApiKey | null {
  const { apiKeyCiphertext } = getAppSettings();
  if (apiKeyCiphertext !== null) {
    const key = decryptSecret(apiKeyCiphertext, "anthropic-api-key");
    if (key !== null) return { source: "app", key };
    console.warn("[ai] the saved API key can't be decrypted");
  }
  return getConfig().hasApiKey ? { source: "env" } : null;
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
