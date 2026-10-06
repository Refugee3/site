export interface UploadResult {
  status: number;
  /** The parsed JSON body, or null when the body is empty or not JSON (e.g. a proxy's HTML error page). */
  json: unknown;
}

function abortError(): DOMException {
  return new DOMException("The upload was cancelled.", "AbortError");
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * POSTs multipart form data with XMLHttpRequest, because fetch cannot report upload progress.
 * `onProgress` receives the uploaded fraction (0..1). Resolves for every HTTP status, so callers inspect
 * `status`; rejects the way fetch does: a TypeError on a network failure, an "AbortError" DOMException
 * when `signal` aborts.
 */
export function uploadWithProgress(
  url: string,
  body: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();
    const cleanUp = () => signal?.removeEventListener("abort", cancel);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    });
    xhr.addEventListener("load", () => {
      cleanUp();
      resolve({ status: xhr.status, json: parseJson(xhr.responseText) });
    });
    xhr.addEventListener("error", () => {
      cleanUp();
      reject(new TypeError("Network error during upload."));
    });
    xhr.addEventListener("abort", () => {
      cleanUp();
      reject(abortError());
    });
    signal?.addEventListener("abort", cancel, { once: true });

    xhr.open("POST", url);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.send(body);
  });
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export interface UploadErrorInfo {
  /** The server's AppErrorCode, when the body has the `{ error: { code, message } }` shape. */
  code: string | null;
  /** A message safe to show to the person uploading. */
  message: string;
}

function fallbackMessage(status: number): string {
  if (status === 413) return "The upload is too large. Remove a file or use photos instead of a large PDF.";
  if (status === 429) return "Too many uploads right now. Wait a minute and try again.";
  if (status === 404) return "This upload link no longer works. Ask your teacher for the current code.";
  if (status >= 500) return "The server had a problem. Try again in a moment.";
  return `The upload failed (error ${status}). Try again.`;
}

/** Reads a failed upload's error, falling back to a message per HTTP status when the body has none. */
export function readUploadError(result: UploadResult): UploadErrorInfo {
  const error = (result.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : null;
  const message =
    typeof error?.message === "string" && error.message.trim() ? error.message : fallbackMessage(result.status);
  return { code, message };
}
