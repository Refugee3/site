import { one, run } from "@/lib/db/sql";

// The "hide student names with ChatGPT" settings (migration 21): the switch and the school's OpenAI-compatible account.

export interface StoredNamesSettings {
  enabled: boolean;
  apiKeyCiphertext: string | null;
  apiKeyMasked: string | null;
  baseUrl: string | null;
  model: string | null;
}

interface NamesRow {
  names_via_chatgpt: 0 | 1;
  openai_api_key_ciphertext: string | null;
  openai_api_key_masked: string | null;
  openai_base_url: string | null;
  openai_model: string | null;
}

export function getStoredNamesSettings(): StoredNamesSettings {
  const row = one<NamesRow>(
    "SELECT names_via_chatgpt, openai_api_key_ciphertext, openai_api_key_masked, openai_base_url, openai_model FROM app_settings WHERE id = 1",
  )!;
  return {
    enabled: row.names_via_chatgpt === 1,
    apiKeyCiphertext: row.openai_api_key_ciphertext,
    apiKeyMasked: row.openai_api_key_masked,
    baseUrl: row.openai_base_url,
    model: row.openai_model,
  };
}

/** `key` undefined keeps the stored key; null removes it. */
export function saveStoredNamesSettings(s: {
  enabled: boolean; baseUrl: string | null; model: string | null; key?: { ciphertext: string; masked: string } | null;
}): void {
  const keep = s.key === undefined;
  run(
    `UPDATE app_settings SET names_via_chatgpt = @enabled, openai_base_url = @base_url, openai_model = @model,
       openai_api_key_ciphertext = CASE WHEN @keep = 1 THEN openai_api_key_ciphertext ELSE @ciphertext END,
       openai_api_key_masked = CASE WHEN @keep = 1 THEN openai_api_key_masked ELSE @masked END
     WHERE id = 1`,
    {
      enabled: s.enabled ? 1 : 0, base_url: s.baseUrl, model: s.model, keep: keep ? 1 : 0,
      ciphertext: keep ? null : (s.key?.ciphertext ?? null), masked: keep ? null : (s.key?.masked ?? null),
    },
  );
}
