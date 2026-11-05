let override: (() => number) | null = null;

/** Current time in epoch ms; tests can pin it with `setClockForTests`. */
export function now(): number {
  return override ? override() : Date.now();
}

export function setClockForTests(fn: (() => number) | null): void {
  override = fn;
}
