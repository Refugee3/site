/** Length in characters (code points), the way SQLite's length() counts them. */
export function charLength(s: string): number {
  return Array.from(s).length;
}

/** The first `max` characters of `s`, never splitting a surrogate pair. */
export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}
