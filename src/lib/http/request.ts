import { getConfig } from "@/lib/config";
import { AppError, isAppError } from "@/lib/errors";
import { logUnexpectedError } from "@/lib/http/log";
import type { UploadedFile } from "@/lib/storage/pdf";

/** Room for multipart boundaries and part headers on top of the file bytes themselves. */
const MULTIPART_OVERHEAD_BYTES = 1_048_576;

// ---------------------------------------------------------------------------------------------
// Reading uploads

/**
 * Buffers a multipart body of at most `maxBytes`: a larger Content-Length is refused before reading, and
 * the stream is counted as it arrives (Content-Length can be absent or wrong) and abandoned past the limit.
 */
export async function readLimitedFormData(req: Request, maxBytes: number): Promise<FormData> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const body = await readBody(req, maxBytes);
  try {
    return await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new AppError("validation", "The upload could not be read. Try again.");
  }
}

async function readBody(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    const next = () => reader.read().catch(() => {
      // A dropped connection (common on classroom wifi) is the client's problem, not a server error to log.
      throw new AppError("validation", "The upload was interrupted. Try again.");
    });
    for (let chunk = await next(); !chunk.done; chunk = await next()) {
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined); // the client may already be gone; nothing to do about it
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function tooLarge(): AppError {
  return new AppError("too_large", "This upload is too large.");
}

/** The files sent under `field`, 1..max of them, in the order they were sent. */
export async function formFiles(fd: FormData, field: string, max: number): Promise<UploadedFile[]> {
  const entries = fd.getAll(field);
  if (entries.some((entry) => typeof entry === "string")) {
    throw new AppError("validation", "Send the files as file uploads.");
  }
  const files = entries as File[];
  if (files.length === 0) throw new AppError("validation", "Choose a file to upload.");
  if (files.length > max) throw new AppError("validation", `Upload at most ${max} ${max === 1 ? "file" : "files"} at a time.`);
  if (files.some((file) => file.size === 0)) throw new AppError("validation", "One of the files is empty.");
  return Promise.all(files.map(async (file) => ({ filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
}

/** Run by every upload handler after its cheap checks: the body within budget, its files, and their summed size within MAX_UPLOAD_MB. */
export async function readUploadedFiles(req: Request, field: string, maxFiles: number): Promise<UploadedFile[]> {
  const { maxUploadBytes } = getConfig();
  const fd = await readLimitedFormData(req, maxUploadBytes + MULTIPART_OVERHEAD_BYTES);
  const files = await formFiles(fd, field, maxFiles);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > maxUploadBytes) {
    throw new AppError("too_large", `Uploads can be at most ${maxUploadBytes / 1_048_576} MB in total.`);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Request facts

/**
 * CSRF guard for route handlers: the Origin header's host must be this server's host as the browser saw
 * it (X-Forwarded-Host, else Host — the same rule as Next's server-action check) or APP_URL's host.
 * Browsers always send Origin on cross-origin POSTs; a missing one is accepted only when `allowMissing`.
 */
export function isSameOrigin(req: Request, o: { allowMissing?: boolean } = {}): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return o.allowMissing === true;
  const originHost = URL.canParse(origin) ? new URL(origin).host : null;
  if (!originHost) return false;
  const requestHost = firstValue(req.headers.get("x-forwarded-host")) ?? req.headers.get("host");
  const appUrl = getConfig().appUrl;
  return originHost === requestHost || (appUrl !== null && originHost === new URL(appUrl).host);
}

/** `isSameOrigin` for mutating handlers: AppError("forbidden") (403) when it fails. */
export function assertSameOrigin(req: Request, o: { allowMissing?: boolean } = {}): void {
  if (!isSameOrigin(req, o)) throw new AppError("forbidden", "This request must come from this site's own pages.");
}

/**
 * The rightmost X-Forwarded-For entry: the address the nearest proxy (or Next itself) saw. Best effort
 * without a proxy, since clients can send the header themselves.
 */
export function clientIp(h: Headers): string | null {
  const ip = h.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return ip ? ip : null;
}

/** The origin browsers use for this server: APP_URL when set, else what the (proxied) request says. */
export function getPublicOrigin(h: Headers): string {
  const appUrl = getConfig().appUrl;
  if (appUrl) return appUrl;
  const proto = firstValue(h.get("x-forwarded-proto")) ?? "http";
  const host = firstValue(h.get("x-forwarded-host")) ?? h.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

/** Proxies may append to forwarding headers ("a, b"); the first entry is the client-facing value. */
function firstValue(header: string | null): string | null {
  const value = header?.split(",")[0].trim();
  return value ? value : null;
}

// ---------------------------------------------------------------------------------------------
// Error responses: { "error": { "code", "message" } }

export function jsonError(e: AppError): Response {
  const headers = new Headers();
  if (e.extra.retryAfterMs !== undefined) headers.set("Retry-After", String(Math.ceil(e.extra.retryAfterMs / 1000)));
  return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status, headers });
}

export function toErrorResponse(err: unknown): Response {
  if (isAppError(err)) return jsonError(err);
  logUnexpectedError("Unhandled error in a route handler", err);
  return jsonError(new AppError("internal", "Something went wrong on the server. Try again."));
}
