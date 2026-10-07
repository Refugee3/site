import { describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "@/lib/config";
import { getAppSettings, setStoredApiKey } from "@/lib/db/repos/settings";
import { encryptSecret } from "@/lib/secrets";
import { seedTeacher, useTestDb } from "@/test/helpers";
import { maskApiKey, normalizeApiKeyInput, resolveApiKey } from "./api-key";

const SAVED_KEY = "sk-ant-api03-SAVEDSAVEDSAVED-xyz_-a1b2";

function useEnv(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  resetConfigForTests();
}

function saveKey(ciphertext: string) {
  setStoredApiKey({ ciphertext, masked: maskApiKey(SAVED_KEY), check: "verified", setBy: seedTeacher().id });
}

describe("normalizeApiKeyInput", () => {
  it.each([
    ["", "Paste your API key."],
    [" \n\t", "Paste your API key."],
    ["sk-ant-admin01-abcdefghijklmnopqrstuvwxyz", "That's an Admin API key. Use a regular API key from Console → API keys."],
    ["sk-ant-api03-short", "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."],
    ["sk-ant-api03 abcdefghijklmnop", "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."],
    ["sk-ant-api03-abcdefgh\nijklmnop", "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."],
    ["sk-proj-abcdefghijklmnopqrstuvwxyz", "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."],
    [`sk-ant-${"a".repeat(301)}`, "That doesn't look like an Anthropic API key. It starts with sk-ant- and has no spaces."],
  ])("rejects %j", (raw, error) => {
    expect(normalizeApiKeyInput(raw)).toEqual({ ok: false, error });
  });

  it("accepts a key and drops the whitespace a paste brings along", () => {
    expect(normalizeApiKeyInput(`  ${SAVED_KEY}\r\n`)).toEqual({ ok: true, key: SAVED_KEY });
    expect(normalizeApiKeyInput(`sk-ant-${"a".repeat(16)}`)).toEqual({ ok: true, key: `sk-ant-${"a".repeat(16)}` });
    expect(normalizeApiKeyInput(`sk-ant-${"a".repeat(300)}`).ok).toBe(true);
  });
});

describe("maskApiKey", () => {
  it("shows only the prefix and the last four characters", () => {
    expect(maskApiKey(SAVED_KEY)).toBe("sk-ant-…a1b2");
    expect(maskApiKey("other-key-9876")).toBe("…9876");
  });
});

describe("resolveApiKey", () => {
  it("is null without a saved key or ANTHROPIC_API_KEY", () => {
    useTestDb();
    expect(resolveApiKey()).toBeNull();
  });

  it("uses ANTHROPIC_API_KEY when nothing is saved, without reading it", () => {
    useEnv({ ANTHROPIC_API_KEY: "sk-ant-env-key-0000000000000000" });
    useTestDb();
    expect(resolveApiKey()).toEqual({ source: "env" });
  });

  it("prefers the key saved in the app", () => {
    useEnv({ ANTHROPIC_API_KEY: "sk-ant-env-key-0000000000000000" });
    useTestDb();
    saveKey(encryptSecret(SAVED_KEY, "anthropic-api-key"));
    expect(resolveApiKey()).toEqual({ source: "app", key: SAVED_KEY, ciphertext: getAppSettings().apiKeyCiphertext });
  });

  it("falls through when the saved key can't be decrypted, and logs no key material", () => {
    useEnv({ APP_SECRET: "a".repeat(32) });
    useTestDb();
    const ciphertext = encryptSecret(SAVED_KEY, "anthropic-api-key");
    saveKey(ciphertext);
    useEnv({ APP_SECRET: "b".repeat(32) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveApiKey()).toBeNull();

    useEnv({ APP_SECRET: "b".repeat(32), ANTHROPIC_API_KEY: "sk-ant-env-key-0000000000000000" });
    expect(resolveApiKey()).toEqual({ source: "env" });

    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).toContain("[ai] the saved API key can't be decrypted");
    expect(logged).not.toContain("SAVED");
    expect(logged).not.toContain(ciphertext);
  });

  it("treats a damaged ciphertext as no saved key", () => {
    useTestDb();
    saveKey("v1.not-a-real-token");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveApiKey()).toBeNull();
    warn.mockRestore();
  });
});
