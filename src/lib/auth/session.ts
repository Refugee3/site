import "server-only";
import { cookies } from "next/headers";
import { now } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { deleteSession, insertSession } from "@/lib/db/repos/sessions";
import { isToken, newToken, sha256Hex } from "@/lib/ids";

export const SESSION_COOKIE = "pag_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// Cookies can only be written in server actions and route handlers (cookies.md), so only those call these.

/** Issues a fresh session token for this browser; only its sha256 is stored. Any previous session here ends. */
export async function createSession(teacherId: string): Promise<void> {
  const store = await cookies();
  endStoredSession(store.get(SESSION_COOKIE)?.value);
  const token = newToken();
  insertSession({ tokenHash: sha256Hex(token), teacherId, expiresAt: now() + SESSION_TTL_MS });
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    secure: getConfig().cookieSecure,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  endStoredSession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
}

/** The key under which a cookie's session is stored; null for a value that cannot be one of our tokens. */
export function sessionTokenHash(token: string | undefined): string | null {
  return token !== undefined && isToken(token) ? sha256Hex(token) : null;
}

function endStoredSession(token: string | undefined): void {
  const hash = sessionTokenHash(token);
  if (hash) deleteSession(hash);
}
