import { now } from "@/lib/clock";
import { one, run, toBit } from "@/lib/db/sql";

export interface AppSettings { studentsCanUpload: boolean; apiKeyCiphertext: string | null; apiKeyMasked: string | null;
  apiKeyCheck: "verified" | "unverified" | null; apiKeySetBy: string | null; apiKeySetAt: number | null; updatedAt: number }

interface AppSettingsRow {
  id: 1;
  students_can_upload: 0 | 1;
  api_key_ciphertext: string | null;
  api_key_masked: string | null;
  api_key_check: "verified" | "unverified" | null;
  api_key_set_by: string | null;
  api_key_set_at: number | null;
  updated_at: number;
}

/** The single settings row (migration 3 inserts it). */
export function getAppSettings(): AppSettings {
  const row = one<AppSettingsRow>("SELECT * FROM app_settings WHERE id = 1")!;
  return {
    studentsCanUpload: row.students_can_upload === 1,
    apiKeyCiphertext: row.api_key_ciphertext,
    apiKeyMasked: row.api_key_masked,
    apiKeyCheck: row.api_key_check,
    apiKeySetBy: row.api_key_set_by,
    apiKeySetAt: row.api_key_set_at,
    updatedAt: row.updated_at,
  };
}

export function setStudentsCanUpload(on: boolean): void {
  run("UPDATE app_settings SET students_can_upload = ?, updated_at = ? WHERE id = 1", toBit(on), now());
}

export function setStoredApiKey(k: { ciphertext: string; masked: string; check: "verified" | "unverified"; setBy: string }): void {
  const at = now();
  run(
    `UPDATE app_settings SET api_key_ciphertext = @ciphertext, api_key_masked = @masked, api_key_check = @check,
       api_key_set_by = @set_by, api_key_set_at = @at, updated_at = @at
     WHERE id = 1`,
    { ciphertext: k.ciphertext, masked: k.masked, check: k.check, set_by: k.setBy, at },
  );
}

export function clearStoredApiKey(): void {
  run(
    `UPDATE app_settings SET api_key_ciphertext = NULL, api_key_masked = NULL, api_key_check = NULL,
       api_key_set_by = NULL, api_key_set_at = NULL, updated_at = ?
     WHERE id = 1`,
    now(),
  );
}
