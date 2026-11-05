import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// Share codes are no longer shown anywhere (the app is for teachers only), but the column is unique and required.
// No 0/O, 1/I/L, from when students typed them.
const SHARE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const SHARE_CODE_LENGTH = 6;

export function newId(): string {
  return randomUUID();
}

export function isId(s: string): boolean {
  return UUID_RE.test(s);
}

export function isToken(s: string): boolean {
  return TOKEN_RE.test(s);
}

/** 32 random bytes as base64url (43 characters, no padding). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newShareCode(): string {
  let code = "";
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    code += SHARE_CODE_ALPHABET[randomInt(SHARE_CODE_ALPHABET.length)];
  }
  return code;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
