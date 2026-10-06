import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs about 128·N·r = 32 MiB, which Node's default maxmem (also 32 MiB) rejects.
const MAX_MEM = 64 * 1024 * 1024;
const SCHEME = "scrypt";
const STORED_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/**
 * A real hash of a random throwaway password. Logins for unknown emails verify against it, so they
 * cost the same scrypt work as logins for real accounts and response times reveal nothing.
 */
export const DUMMY_HASH =
  "scrypt$32768$8$1$4I7s-Z8esMXJ1m3Dvzqm9Q$Yv3WRZsuuXa-a9zuPFGfPpW3voEkbvap9Idrjz1GDjjvvVgj7NTBo4VmxY8vv_JXwGdTLvMs5w7vbWiSF_lYGA";

/** "scrypt$N$r$p$<salt>$<hash>" with base64url salt and hash; the parameters travel with the hash. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await deriveKey(pw, salt, PARAMS, KEY_LENGTH);
  return [SCHEME, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

/** Constant-time check of `pw` against a stored hash; a malformed stored value never matches. */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  const candidate = await deriveKey(pw, parsed.salt, parsed.params, parsed.hash.length);
  return timingSafeEqual(candidate, parsed.hash);
}

function parseStored(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const match = STORED_RE.exec(stored);
  if (!match) return null;
  const [, N, r, p, salt, hash] = match;
  const hashBytes = Buffer.from(hash, "base64url");
  if (hashBytes.length !== KEY_LENGTH) return null;
  return { params: { N: Number(N), r: Number(r), p: Number(p) }, salt: Buffer.from(salt, "base64url"), hash: hashBytes };
}

function deriveKey(pw: string, salt: Buffer, params: ScryptParams, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, keyLength, { ...params, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
