import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

export type SecretPurpose = "anthropic-api-key";

const TOKEN_VERSION = "v1";
const HKDF_SALT = "pag-secrets-v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
/** Shown to the teacher who tries to save a key, and logged for whoever runs the server; it carries no user data. */
const DAMAGED_KEY_FILE = "The server's secret key file (DATA_DIR/secret.key) is damaged, so API keys can't be saved. "
  + "Ask whoever runs this server to restore it from a backup or set APP_SECRET.";

function keyFilePath(): string {
  return path.join(getConfig().dataDir, "secret.key");
}

function isErrno(e: unknown, code: string): boolean {
  return errnoCode(e) === code;
}

function errnoCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown error";
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

/** Errors of a filesystem that has no hard links (some network or FAT mounts). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Creates the key file atomically and durably: the bytes are written and synced to a staging file in DATA_DIR/tmp
 * (swept hourly), which is then hard-linked into place, so DATA_DIR/secret.key never exists partly written (a full
 * disk, a crash or a power cut leaves no file, or the whole one). When another process won the race, its file is used.
 * On a filesystem without hard links the file is created in place instead (exclusively, then synced).
 */
function createKeyFile(): Buffer {
  const file = keyFilePath();
  const dir = path.dirname(file);
  const staging = path.join(dir, "tmp", `secret-key-${randomBytes(12).toString("hex")}`);
  const created = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  try {
    writeNewFileSynced(staging, created);
    try {
      fs.linkSync(staging, file);
    } catch (e) {
      if (!NO_HARD_LINKS.has(errnoCode(e))) return winnerOrThrow(e);
      try {
        writeNewFileSynced(file, created);
      } catch (inPlace) {
        return winnerOrThrow(inPlace);
      }
    }
    syncDir(dir);
    return created;
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

/** Creates `file` (failing with EEXIST when it exists) with `bytes`, synced to disk; removed again if writing fails. */
function writeNewFileSynced(file: string, bytes: Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    try {
      for (let written = 0; written < bytes.length;) written += fs.writeSync(fd, bytes, written);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
}

/** After creating the key file failed: the file another process created meanwhile (EEXIST), else rethrows. */
function winnerOrThrow(e: unknown): Buffer {
  const winner = isErrno(e, "EEXIST") ? readKeyFile() : null;
  if (winner) return winner;
  throw e;
}

/** Makes the new directory entry durable; best effort (some platforms can't open a directory). */
function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // The file itself is synced; at worst a power cut right now loses the new key file, and the saved key with it.
  }
}

function appSecret(): Buffer | null {
  const secret = getConfig().appSecret;
  return secret === null ? null : Buffer.from(secret, "utf8");
}

/**
 * APP_SECRET, else the key file, created on first use. A damaged key file throws an AppError whose message tells
 * the teacher who tries to save a key what the server needs (and is logged for whoever runs it).
 */
function masterForEncrypt(): Buffer {
  const fromEnv = appSecret();
  if (fromEnv !== null) return fromEnv;
  const master = readKeyFile() ?? createKeyFile();
  if (master.length !== KEY_BYTES) {
    console.error(`[secrets] ${DAMAGED_KEY_FILE}`);
    throw new AppError("internal", DAMAGED_KEY_FILE);
  }
  return master;
}

/**
 * APP_SECRET, else the key file; null when the file is missing, damaged or can't be read (decrypting never creates
 * it). A read error is logged by its code only: the saved key then shows as unreadable instead of taking pages down.
 */
function masterForDecrypt(): Buffer | null {
  const fromEnv = appSecret();
  if (fromEnv !== null) return fromEnv;
  let master: Buffer | null;
  try {
    master = readKeyFile();
  } catch (e) {
    console.error(`[secrets] can't read DATA_DIR/secret.key (${errnoCode(e)})`);
    return null;
  }
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
