import type * as z from "zod";
import { AppError } from "@/lib/errors";

/**
 * Validates untrusted input. A failure throws AppError("validation") whose fieldErrors are keyed by the
 * issue path joined with "." (e.g. "items.3.pointsCenti"), the same keys the services use.
 */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fieldErrors = fieldErrorsOf(result.error);
  // A scalar input has no field to highlight, so its own message is the clearest error.
  const message = Object.keys(fieldErrors).length > 0 ? "Some fields need fixing." : result.error.issues[0].message;
  throw new AppError("validation", message, { fieldErrors });
}

function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    if (issue.path.length === 0) continue;
    (fieldErrors[issue.path.map(String).join(".")] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/** The named text fields of a form; a missing field (or a file in its place) is undefined, so schema defaults apply. */
export function formFields<K extends string>(fd: FormData, names: readonly K[]): Record<K, string | undefined> {
  const fields = {} as Record<K, string | undefined>;
  for (const name of names) {
    const value = fd.get(name);
    fields[name] = typeof value === "string" ? value : undefined;
  }
  return fields;
}
