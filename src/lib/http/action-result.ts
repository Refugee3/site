import { isAppError } from "@/lib/errors";
import { logUnexpectedError } from "@/lib/http/log";
import type { ActionResult } from "@/lib/types";

type ActionFailure = Extract<ActionResult, { ok: false }>;

// The validate-and-mutate part of a server action. AppErrors become a failed ActionResult carrying their
// user-safe message and field errors; anything else is logged and reported generically. The DAL's
// redirect()/notFound() and the action's own redirect() must stay outside: they throw on purpose.

/** Runs `fn` and reports only success or failure, so whatever the service returns never reaches the client. */
export async function attempt(fn: () => unknown): Promise<ActionResult> {
  const result = await attemptWithData(fn);
  return result.ok ? { ok: true } : result;
}

/** Runs `fn` and returns its result to the client as `data`. */
export async function attemptWithData<T>(fn: () => T | Promise<T>): Promise<{ ok: true; data: T } | ActionFailure> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return actionFailure(e);
  }
}

function actionFailure(e: unknown): ActionFailure {
  if (isAppError(e)) {
    const { fieldErrors } = e.extra;
    return fieldErrors && Object.keys(fieldErrors).length > 0 ? { ok: false, error: e.message, fieldErrors } : { ok: false, error: e.message };
  }
  logUnexpectedError("Unhandled error in a server action", e);
  return { ok: false, error: "Something went wrong on the server. Try again." };
}
