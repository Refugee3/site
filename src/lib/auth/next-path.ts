/** Where teachers land after logging in, and the only area `?next=` may point into. */
export const TEACHER_HOME = "/teacher";

/** Request header in which `src/proxy.ts` passes the requested teacher page (path and query) to the DAL. */
export const RETURN_TO_HEADER = "x-return-to";

/**
 * A safe place to go after logging in: `next` when it is a teacher page, else the teacher home. Only paths
 * on this site qualify, so this is no open redirect. Resolving the path first normalizes "/teacher/../login"
 * (also spelled with backslashes or "%2e%2e") and drops tabs and line breaks, which must not reach a
 * Location header; anything else unusual in the query comes back percent-encoded.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== "string" || !isTeacherPath(next)) return TEACHER_HOME;
  const url = new URL(next, "http://same-origin.invalid");
  return url.origin === "http://same-origin.invalid" && isTeacherPath(url.pathname) ? url.pathname + url.search : TEACHER_HOME;
}

/** "/teacher" itself or a path below it ("/teachers" is not one). */
function isTeacherPath(path: string): boolean {
  return path === TEACHER_HOME || path.startsWith(`${TEACHER_HOME}/`) || path.startsWith(`${TEACHER_HOME}?`);
}
