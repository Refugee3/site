import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigForTests } from "@/lib/config";
import { decryptSecret, encryptSecret, type SecretPurpose } from "@/lib/secrets";

const PURPOSE: SecretPurpose = "anthropic-api-key";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const DAMAGED = "The server's secret key file (DATA_DIR/secret.key) is damaged, so API keys can't be saved. "
  + "Ask whoever runs this server to restore it from a backup or set APP_SECRET.";
const TOKEN_SHAPE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/;

afterEach(() => {
  vi.restoreAllMocks();
});

function keyFile(): string {
  return path.join(getConfig().dataDir, "secret.key");
}

function useAppSecret(secret: string): void {
  vi.stubEnv("APP_SECRET", secret);
  resetConfigForTests();
}

/** Replaces the base64url part `index` (1 = iv, 2 = tag, 3 = ciphertext) with the same bytes, one bit flipped. */
function flipBit(token: string, index: number): string {
  const parts = token.split(".");
  const bytes = Buffer.from(parts[index], "base64url");
  bytes[0] ^= 1;
  parts[index] = bytes.toString("base64url");
  return parts.join(".");
}

describe("encryptSecret and decryptSecret", () => {
  it("round-trips through a generated DATA_DIR/secret.key (32 bytes, mode 0600)", () => {
    expect(fs.existsSync(keyFile())).toBe(false);

    const token = encryptSecret(KEY, PURPOSE);

    expect(token).toMatch(TOKEN_SHAPE);
    expect(token).not.toContain("abcdefghijklmnop");
    const stat = fs.statSync(keyFile());
    expect(stat.size).toBe(32);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(decryptSecret(token, PURPOSE)).toBe(KEY);
  });

  it("reuses the existing key file and a fresh IV for every encryption", () => {
    const first = encryptSecret(KEY, PURPOSE);
    const master = fs.readFileSync(keyFile());
    const second = encryptSecret(KEY, PURPOSE);

    expect(fs.readFileSync(keyFile())).toEqual(master);
    expect(second).not.toBe(first);
    expect(decryptSecret(first, PURPOSE)).toBe(KEY);
    expect(decryptSecret(second, PURPOSE)).toBe(KEY);
  });

  it("round-trips with APP_SECRET and then needs no key file", () => {
    useAppSecret("an-app-secret-of-at-least-32-characters");

    const token = encryptSecret(KEY, PURPOSE);

    expect(decryptSecret(token, PURPOSE)).toBe(KEY);
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("round-trips an empty and a non-ASCII plaintext", () => {
    expect(decryptSecret(encryptSecret("", PURPOSE), PURPOSE)).toBe("");
    expect(decryptSecret(encryptSecret("clé ✓", PURPOSE), PURPOSE)).toBe("clé ✓");
  });

  it("returns null under another master secret", () => {
    const fromFile = encryptSecret(KEY, PURPOSE);
    useAppSecret("an-app-secret-of-at-least-32-characters");
    expect(decryptSecret(fromFile, PURPOSE)).toBeNull();

    const fromSecret = encryptSecret(KEY, PURPOSE);
    useAppSecret("another-app-secret-of-at-least-32-chars");
    expect(decryptSecret(fromSecret, PURPOSE)).toBeNull();
  });

  it("returns null when the key file was replaced", () => {
    const token = encryptSecret(KEY, PURPOSE);
    fs.writeFileSync(keyFile(), Buffer.alloc(32, 7));
    expect(decryptSecret(token, PURPOSE)).toBeNull();
  });

  it("returns null for a tampered IV, tag or ciphertext", () => {
    const token = encryptSecret(KEY, PURPOSE);
    for (const index of [1, 2, 3]) expect(decryptSecret(flipBit(token, index), PURPOSE), String(index)).toBeNull();
    const [version, iv, tag, ciphertext] = token.split(".");
    expect(decryptSecret([version, iv, tag, ciphertext.slice(0, -2)].join("."), PURPOSE)).toBeNull();
  });

  it("returns null for another purpose", () => {
    const token = encryptSecret(KEY, PURPOSE);
    expect(decryptSecret(token, "other-purpose" as SecretPurpose)).toBeNull();
  });

  it.each([
    ["an empty string", ""],
    ["plain text", "not a token"],
    ["too few parts", "v1.abc.def"],
    ["too many parts", "v1.a.b.c.d"],
    ["another version", "v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
    ["characters outside base64url", "v1.AAAAAAAAAAAAAAA+.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
    ["a short IV", "v1.AAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
    ["a short tag", "v1.AAAAAAAAAAAAAAAA.AAAA.AAAA"],
  ])("returns null for %s", (_name, token) => {
    encryptSecret(KEY, PURPOSE);
    expect(decryptSecret(token, PURPOSE)).toBeNull();
  });

  it("returns null without creating a key file when there is none", () => {
    const token = encryptSecret(KEY, PURPOSE);
    fs.rmSync(keyFile());

    expect(decryptSecret(token, PURPOSE)).toBeNull();
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it.each([
    ["a truncated", Buffer.alloc(31, 1)],
    ["an empty", Buffer.alloc(0)],
  ])("refuses to encrypt with %s key file, with a message for whoever runs the server, and decrypts nothing with it", (_name, bytes) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = encryptSecret(KEY, PURPOSE);
    fs.writeFileSync(keyFile(), bytes);

    expect(() => encryptSecret(KEY, PURPOSE)).toThrow(expect.objectContaining({ code: "internal", message: DAMAGED }));
    expect(error).toHaveBeenCalledWith(`[secrets] ${DAMAGED}`);
    expect(decryptSecret(token, PURPOSE)).toBeNull();
  });

  it("returns null, logging only the error code, when the key file can't be read", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = encryptSecret(KEY, PURPOSE);
    // E.g. a bind mount of a missing host file, which Docker creates as a directory.
    fs.rmSync(keyFile());
    fs.mkdirSync(keyFile());
    try {
      expect(decryptSecret(token, PURPOSE)).toBeNull();
      expect(error).toHaveBeenCalledWith("[secrets] can't read DATA_DIR/secret.key (EISDIR)");
    } finally {
      fs.rmdirSync(keyFile());
    }
  });
});

describe("creating the key file", () => {
  it("leaves no key file behind when writing it fails, so the next save creates a whole one", () => {
    vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });

    expect(() => encryptSecret(KEY, PURPOSE)).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(fs.readdirSync(path.join(getConfig().dataDir, "tmp"))).toEqual([]);

    vi.restoreAllMocks();
    const token = encryptSecret(KEY, PURPOSE);
    expect(fs.statSync(keyFile()).size).toBe(32);
    expect(decryptSecret(token, PURPOSE)).toBe(KEY);
  });

  it("creates the key file in place on a filesystem without hard links", () => {
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    const token = encryptSecret(KEY, PURPOSE);

    expect(fs.statSync(keyFile()).size).toBe(32);
    expect(fs.readdirSync(path.join(getConfig().dataDir, "tmp"))).toEqual([]);
    expect(decryptSecret(token, PURPOSE)).toBe(KEY);
  });

  it("uses the key file another process created first", () => {
    const theirs = Buffer.alloc(32, 9);
    const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementationOnce((from, to) => {
      fs.writeFileSync(keyFile(), theirs); // the other process wins the race
      link(from, to);
    });

    const token = encryptSecret(KEY, PURPOSE);

    expect(fs.readFileSync(keyFile())).toEqual(theirs);
    expect(decryptSecret(token, PURPOSE)).toBe(KEY);
  });
});
