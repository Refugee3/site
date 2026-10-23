import "server-only";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionErrorEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { truncateChars } from "@/lib/grading/text";
import { AiError, type AiErrorCode, classifySdkError } from "../errors";

// Maps what the hosted agent's calls and sessions report onto the existing AiError codes, so the job layer's
// retry, pause and backoff rules and the key banner work unchanged. The messages of the codes Settings shows
// (auth, agent_unavailable, billing) are written for the teacher.

const KEY_REJECTED = "Anthropic rejected the API key. Replace it above.";
const NOT_ALLOWED = "This API key isn't allowed to use Claude Managed Agents. In the Anthropic Console, check that Managed Agents "
  + "is available to your organization and workspace, or switch to Direct API.";
const NOT_AVAILABLE = "Claude Managed Agents isn't available to this API key. Check your organization's access in the Anthropic Console, "
  + "or switch to Direct API.";
const BILLING = "Anthropic reports a billing problem. Check the plan and credits in the Anthropic Console.";
const SESSION_GONE = "The hosted agent's session disappeared.";
const API_MESSAGE_MAX_CHARS = 200;

const TRANSIENT: ReadonlySet<AiErrorCode> = new Set(["rate_limited", "overloaded", "server_error", "connection", "timeout"]);

/** SDK errors from agents/environments calls (setup). */
export function provisioningError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof AuthenticationError) return new AiError("auth", KEY_REJECTED, { retryable: false, pauseWorker: true });
  if (e instanceof PermissionDeniedError) return new AiError("agent_unavailable", NOT_ALLOWED, { retryable: false, pauseWorker: true });
  if (e instanceof NotFoundError) return new AiError("agent_unavailable", NOT_AVAILABLE, { retryable: false, pauseWorker: true });
  const classified = classifySdkError(e);
  if (classified.code === "billing") return new AiError("billing", BILLING, { retryable: false, pauseWorker: true });
  if (e instanceof BadRequestError || e instanceof UnprocessableEntityError) {
    const detail = truncateChars(apiMessage(e), API_MESSAGE_MAX_CHARS);
    return new AiError("agent_unavailable", `Anthropic refused the hosted agent's settings: ${detail}. Switch to Direct API and report this.`,
      { retryable: false, pauseWorker: true });
  }
  // Someone keeps editing an agent in the Console: the next setup tries again.
  if (e instanceof ConflictError) return new AiError("server_error", unreachable("server_error"), { retryable: true });
  if (TRANSIENT.has(classified.code)) return new AiError(classified.code, unreachable(classified.code), classified.o);
  return classified;
}

/** Setup found the environment's name taken by one it can't use (an archived one keeps its name). */
export function environmentNameTaken(name: string): AiError {
  return new AiError("agent_unavailable", `An environment named "${name}" already exists in your Anthropic workspace but can't be used `
    + "(it may be archived). Delete it in the Anthropic Console, then press Set up again, or switch to Direct API.",
  { retryable: false, pauseWorker: true });
}

/** SDK errors from files/sessions/events calls. 403 → agent_unavailable; everything else as classifySdkError. */
export function sessionCallError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof AuthenticationError) return new AiError("auth", KEY_REJECTED, { retryable: false, pauseWorker: true });
  if (e instanceof PermissionDeniedError) return new AiError("agent_unavailable", NOT_ALLOWED, { retryable: false, pauseWorker: true });
  if (e instanceof NotFoundError) return new AiError("server_error", SESSION_GONE, { retryable: true });
  return classifySdkError(e);
}

/** A session.error event (or none) → AiError; `fallback` is the message when there is no event. */
export function sessionErrorToAiError(ev: BetaManagedAgentsSessionErrorEvent | null, fallback: string): AiError {
  if (ev === null) return new AiError("server_error", fallback, { retryable: true });
  const message = ev.error.message.trim() || fallback;
  switch (ev.error.type) {
    case "model_overloaded_error":
      return new AiError("overloaded", message, { retryable: true });
    case "model_rate_limited_error":
      return new AiError("rate_limited", message, { retryable: true, retryAfterMs: null });
    case "billing_error":
      return new AiError("billing", BILLING, { retryable: false, pauseWorker: true });
    default:
      return new AiError("server_error", message, { retryable: true });
  }
}

/** The teacher-readable text stored in agent_error and shown in Settings. */
export function teacherMessageFor(err: AiError): string {
  if (err.code === "auth" || err.code === "agent_unavailable" || err.code === "billing") return err.message;
  if (TRANSIENT.has(err.code)) return unreachable(err.code);
  return `Setting up the hosted agent failed (${err.code}). Try again, or switch to Direct API.`;
}

/** The API's own error message: the SDK puts the whole JSON body into APIError.message. */
export function apiMessage(e: APIError): string {
  const body = e.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === "string" ? message : e.message;
}

function unreachable(code: AiErrorCode): string {
  return `Anthropic couldn't be reached just now (${code}). It's tried again before the next paper.`;
}
