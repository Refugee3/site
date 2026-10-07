import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAbortError, newUploadId, readUploadError, uploadWithProgress } from "./upload";

type Listener = (event: { lengthComputable: boolean; loaded: number; total: number }) => void;

class Emitter {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event = { lengthComputable: false, loaded: 0, total: 0 }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Just enough of XMLHttpRequest for uploadWithProgress, driven by the test. */
class FakeXhr extends Emitter {
  static instances: FakeXhr[] = [];
  upload = new Emitter();
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = undefined;
  status = 0;
  responseText = "";

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.emit("abort");
  }
  respond(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.emit("load");
  }
}

const lastXhr = () => FakeXhr.instances.at(-1)!;

beforeEach(() => {
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

describe("uploadWithProgress", () => {
  it("POSTs the form data and resolves with the status and parsed JSON", async () => {
    const body = new FormData();
    const pending = uploadWithProgress("/api/s/K7M4QX/submissions", body, () => {});
    const xhr = lastXhr();
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/s/K7M4QX/submissions");
    expect(xhr.headers.Accept).toBe("application/json");
    expect(xhr.body).toBe(body);

    xhr.respond(201, JSON.stringify({ receiptUrl: "/r/abc" }));
    await expect(pending).resolves.toEqual({ status: 201, json: { receiptUrl: "/r/abc" } });
  });

  it("sends extra headers, such as the upload id", async () => {
    const pending = uploadWithProgress("/u", new FormData(), () => {}, undefined, { "Idempotency-Key": "abc" });
    expect(lastXhr().headers).toEqual({ Accept: "application/json", "Idempotency-Key": "abc" });
    lastXhr().respond(201, "{}");
    await pending;
  });

  it("resolves error statuses too, with json null for a non-JSON body", async () => {
    const pending = uploadWithProgress("/u", new FormData(), () => {});
    lastXhr().respond(413, "<html>Request Entity Too Large</html>");
    await expect(pending).resolves.toEqual({ status: 413, json: null });
  });

  it("reports upload progress as a fraction, ignoring events without a known length", async () => {
    const onProgress = vi.fn();
    const pending = uploadWithProgress("/u", new FormData(), onProgress);
    const xhr = lastXhr();
    xhr.upload.emit("progress", { lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.emit("progress", { lengthComputable: false, loaded: 50, total: 0 });
    xhr.upload.emit("progress", { lengthComputable: true, loaded: 100, total: 100 });
    xhr.respond(201, "{}");
    await pending;
    expect(onProgress.mock.calls).toEqual([[0.25], [1]]);
  });

  it("rejects with a TypeError on a network failure", async () => {
    const pending = uploadWithProgress("/u", new FormData(), () => {});
    lastXhr().emit("error");
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });

  it("aborts the request when the signal fires and rejects with an AbortError", async () => {
    const controller = new AbortController();
    const pending = uploadWithProgress("/u", new FormData(), () => {}, controller.signal);
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
  });

  it("rejects without sending when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await uploadWithProgress("/u", new FormData(), () => {}, controller.signal).catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(FakeXhr.instances).toHaveLength(0);
  });
});

describe("readUploadError", () => {
  it("uses the server's code and message", () => {
    const json = { error: { code: "closed", message: "This assignment is closed." } };
    expect(readUploadError({ status: 403, json })).toEqual({ code: "closed", message: "This assignment is closed." });
  });

  it("falls back to a message per status when the body has none", () => {
    expect(readUploadError({ status: 413, json: null })).toEqual({
      code: null,
      message: expect.stringContaining("too large"),
    });
    expect(readUploadError({ status: 429, json: "nope" }).message).toContain("Wait a minute");
    expect(readUploadError({ status: 502, json: { error: { code: 5, message: "" } } })).toEqual({
      code: null,
      message: expect.stringContaining("server had a problem"),
    });
    expect(readUploadError({ status: 400, json: [] }).message).toContain("error 400");
  });
});

describe("isAbortError", () => {
  it("recognizes only AbortError DOMExceptions", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("x", "NotAllowedError"))).toBe(false);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
  });
});

describe("newUploadId", () => {
  it("is 32 random hex characters", () => {
    const id = newUploadId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newUploadId()).not.toBe(id);
  });
});
