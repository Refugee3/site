/**
 * Logs an unexpected error by class, code and stack frames only. Messages are left out because they
 * can quote user input, and logs must never carry names, PDFs or tokens.
 */
export function logUnexpectedError(context: string, err: unknown): void {
  console.error(`${context}: ${describeError(err)}`);
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return `non-Error value (${typeof err})`;
  const code = (err as { code?: unknown }).code;
  const heading = typeof code === "string" ? `${err.name} (${code})` : err.name;
  const frames = (err.stack ?? "").split("\n").filter((line) => line.trimStart().startsWith("at "));
  return [heading, ...frames].join("\n");
}
