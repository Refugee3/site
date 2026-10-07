import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";

export type SecretPurpose = "anthropic-api-key";

const TOKEN_VERSION = "v1";
const HKDF_SALT = "pag-secrets-v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const DAMAGED_KEY_FILE = "DATA_DIR/secret.key is damaged; restore it from a backup or set APP_SECRET";

function keyFilePath(): string {
  return path.join(getConfig().dataDir, "secret.key");
}

function isErrno(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === code;
}

/** The key file's bytes, or null when there is none. */
function readKeyFile(): Buffer | null {
  try {
    return fs.readFileSync(keyFilePath());
  } catch (e) {
    if (isErrno(e, "ENOENT")) return null;
    throw e;
  }
}

function createKeyFile(): Buffer {
  const file = keyFilePath();
  const created = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, created, { flag: "wx", mode: 0o600 });
    return created;
  } catch (e) {
    if (isErrno(e, "EEXIST")) return fs.readFileSync(file); // created by someone else meanwhile
    throw e;
  }
}

function appSecret(): Buffer | null {
  const secret = getConfig().appSecret;
  return secret === null ? null : Buffer.from(secret, "utf8");
}

/** APP_SECRET, else the key file, created on first use. */
function masterForEncrypt(): Buffer {
  const fromEnv = appSecret();
  if (fromEnv !== null) return fromEnv;
  const master = readKeyFile() ?? createKeyFile();
  if (master.length !== KEY_BYTES) throw new Error(DAMAGED_KEY_FILE);
  return master;
}

/** APP_SECRET, else the key file; null when the file is missing or damaged (decrypting never creates it). */
function masterForDecrypt(): Buffer | null {
  const fromEnv = appSecret();
  if (fromEnv !== null) return fromEnv;
  const master = readKeyFile();
  return master?.length === KEY_BYTES ? master : null;
}

function deriveKey(master: Buffer, purpose: SecretPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, purpose, KEY_BYTES));
}

function aad(purpose: SecretPurpose): Buffer {
  return Buffer.from(`pag:${purpose}`, "utf8");
}

/** AES-256-GCM under a key derived for `purpose`; returns "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function encryptSecret(plaintext: string, purpose: SecretPurpose): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterForEncrypt(), purpose), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const encoded = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url"));
  return [TOKEN_VERSION, ...encoded].join(".");
}

/** The plaintext, or null when `token` can't be decrypted here (other master, tampered, bad format, no key file). */
export function decryptSecret(token: string, purpose: SecretPurpose): string | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION || !parts.every((part) => BASE64URL.test(part))) return null;
  const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  const master = masterForDecrypt();
  if (master === null) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(master, purpose), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
