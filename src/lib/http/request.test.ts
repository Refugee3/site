import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  assertSameOrigin, clientIp, formFiles, getPublicOrigin, isSameOrigin, jsonError, readLimitedFormData, readUploadedFiles,
  toErrorResponse,
} from "@/lib/http/request";

const MIB = 1_048_576;

function setEnv(vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  resetConfigForTests();
}

beforeEach(() => setEnv({ APP_URL: "", MAX_UPLOAD_MB: "" }));

async function caught(fn: () => unknown): Promise<AppError> {
  const error = await Promise.resolve().then(fn).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

function post(headers: Record<string, string>): Request {
  return new Request("http://internal:3000/api/x", { method: "POST", headers });
}

/** A multipart request with exact Content-Type and Content-Length, as a browser would send it. */
async function multipart(fd: FormData): Promise<Request> {
  const encoded = new Response(fd);
  const body = new Uint8Array(await encoded.arrayBuffer());
  return new Request("http://localhost/upload", {
    method: "POST",
    body,
    headers: { "content-type": encoded.headers.get("content-type")!, "content-length": String(body.byteLength) },
  });
}

/** A request whose body arrives in `chunks` (no Content-Length unless given); `cancelled` records abandonment. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}): { req: Request; cancelled: () => boolean } {
  let wasCancelled = false;
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(chunks[next++]);
      else controller.close();
    },
    cancel() {
      wasCancelled = true;
    },
  });
  const init = { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=x", ...headers } };
  return { req: new Request("http://localhost/upload", init as RequestInit), cancelled: () => wasCancelled };
}

function file(name: string, bytes: number[] | Uint8Array, type = "application/pdf"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

interface OriginCase {
  name: string;
  headers: Record<string, string>;
  allowMissing?: boolean;
  expected: boolean;
}

describe("isSameOrigin", () => {
  it.each<OriginCase>([
    { name: "no Origin, default", headers: { host: "grader.test" }, expected: false },
    { name: "no Origin, allowMissing", headers: { host: "grader.test" }, allowMissing: true, expected: true },
    { name: "Origin matches Host", headers: { origin: "https://grader.test", host: "grader.test" }, expected: true },
    { name: "Origin from another site", headers: { origin: "https://evil.test", host: "grader.test" }, allowMissing: true, expected: false },
    { name: "port differs", headers: { origin: "http://grader.test:8080", host: "grader.test" }, expected: false },
    { name: "opaque Origin", headers: { origin: "null", host: "grader.test" }, allowMissing: true, expected: false },
    { name: "malformed Origin", headers: { origin: "not a url", host: "grader.test" }, allowMissing: true, expected: false },
    {
      name: "X-Forwarded-Host wins over Host",
      headers: { origin: "https://grader.test", host: "127.0.0.1:3000", "x-forwarded-host": "grader.test" },
      expected: true,
    },
    {
      name: "Host is ignored when X-Forwarded-Host differs",
      headers: { origin: "https://127.0.0.1:3000", host: "127.0.0.1:3000", "x-forwarded-host": "grader.test" },
      expected: false,
    },
    {
      name: "first X-Forwarded-Host entry",
      headers: { origin: "https://grader.test", host: "internal", "x-forwarded-host": "grader.test, proxy.internal" },
      expected: true,
    },
  ])("$name → $expected", ({ headers, allowMissing, expected }) => {
    expect(isSameOrigin(post(headers), { allowMissing })).toBe(expected);
  });

  it("accepts APP_URL's host when a proxy rewrites Host", () => {
    const req = post({ origin: "https://grader.school.org", host: "127.0.0.1:3000" });
    expect(isSameOrigin(req)).toBe(false);
    setEnv({ APP_URL: "https://grader.school.org" });
    expect(isSameOrigin(req)).toBe(true);
  });

  it("is enforced by assertSameOrigin with a 403", async () => {
    const error = await caught(() => assertSameOrigin(post({ origin: "https://evil.test", host: "grader.test" })));
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(() => assertSameOrigin(post({ host: "grader.test" }), { allowMissing: true })).not.toThrow();
  });
});

describe("clientIp", () => {
  it.each([
    { header: undefined, ip: null },
    { header: "", ip: null },
    { header: "203.0.113.7", ip: "203.0.113.7" },
    { header: "198.51.100.1, 10.0.0.2 , 203.0.113.7 ", ip: "203.0.113.7" },
    { header: "198.51.100.1, ", ip: null },
    { header: "2001:db8::1", ip: "2001:db8::1" },
  ])("X-Forwarded-For $header → $ip", ({ header, ip }) => {
    const h = new Headers(header === undefined ? {} : { "x-forwarded-for": header });
    expect(clientIp(h)).toBe(ip);
  });
});

describe("getPublicOrigin", () => {
  it("prefers APP_URL", () => {
    setEnv({ APP_URL: "https://grader.school.org" });
    expect(getPublicOrigin(new Headers({ host: "127.0.0.1:3000" }))).toBe("https://grader.school.org");
  });

  it("falls back to the forwarded protocol and host, then to Host over http", () => {
    expect(getPublicOrigin(new Headers({ host: "127.0.0.1:3000", "x-forwarded-proto": "https, http", "x-forwarded-host": "grader.test" })))
      .toBe("https://grader.test");
    expect(getPublicOrigin(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
});

describe("readLimitedFormData", () => {
  it("parses a body within the limit", async () => {
    const fd = new FormData();
    fd.append("files", file("a.pdf", [1, 2, 3]));
    fd.append("note", "hello");
    const parsed = await readLimitedFormData(await multipart(fd), 10_000);
    expect(parsed.get("note")).toBe("hello");
    expect(new Uint8Array(await (parsed.get("files") as File).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses a declared Content-Length over the limit without reading the body", async () => {
    const { req, cancelled } = streamed([new Uint8Array(10)], { "content-length": "2001" });
    const error = await caught(() => readLimitedFormData(req, 2000));
    expect(error.code).toBe("too_large");
    expect(error.status).toBe(413);
    expect(cancelled()).toBe(false);
  });

  it("stops reading a streamed body as soon as it passes the limit", async () => {
    const { req, cancelled } = streamed([new Uint8Array(600), new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)]);
    const error = await caught(() => readLimitedFormData(req, 1000));
    expect(error.code).toBe("too_large");
    expect(cancelled()).toBe(true);
  });

  it("reports an unreadable body as a validation error", async () => {
    const { req } = streamed([new TextEncoder().encode("this is not multipart")]);
    expect((await caught(() => readLimitedFormData(req, 1000))).code).toBe("validation");
  });

  it("reports a dropped connection as an interrupted upload rather than a server error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new TypeError("terminated"));
      },
    });
    const init = { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=x" } };
    const error = await caught(() => readLimitedFormData(new Request("http://localhost/upload", init as RequestInit), 1000));
    expect(error).toMatchObject({ code: "validation", message: "The upload was interrupted. Try again." });
  });
});

describe("formFiles", () => {
  it("returns the files in the order they were sent", async () => {
    const fd = new FormData();
    fd.append("files", file("page1.jpg", [0xff, 0xd8, 0xff], "image/jpeg"));
    fd.append("files", file("page2.pdf", [0x25, 0x50]));
    fd.append("other", file("ignored.pdf", [1]));
    const files = await formFiles(fd, "files", 20);
    expect(files.map((f) => f.filename)).toEqual(["page1.jpg", "page2.pdf"]);
    expect(files[0].bytes).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it.each([
    { name: "no file", build: (fd: FormData) => fd.append("other", "x") },
    { name: "a text field instead of a file", build: (fd: FormData) => fd.append("file", "%PDF-1.4") },
    { name: "too many files", build: (fd: FormData) => [1, 2].forEach((i) => fd.append("file", file(`${i}.pdf`, [i]))) },
    { name: "an empty file", build: (fd: FormData) => fd.append("file", file("empty.pdf", [])) },
  ])("rejects $name", async ({ build }) => {
    const fd = new FormData();
    build(fd);
    expect((await caught(() => formFiles(fd, "file", 1))).code).toBe("validation");
  });
});

describe("readUploadedFiles", () => {
  it("allows multipart overhead but not more file bytes than MAX_UPLOAD_MB", async () => {
    setEnv({ MAX_UPLOAD_MB: "1" });
    const half = new Uint8Array(MIB / 2);
    const fd = new FormData();
    fd.append("files", file("a.jpg", half));
    fd.append("files", file("b.jpg", half));
    expect(await readUploadedFiles(await multipart(fd), "files", 20)).toHaveLength(2);

    fd.append("files", file("c.jpg", [1]));
    const error = await caught(async () => readUploadedFiles(await multipart(fd), "files", 20));
    expect(error.code).toBe("too_large");
    expect(error.message).toContain("1 MB");
  });

  it("takes a larger budget for a whole-class scan", async () => {
    setEnv({ MAX_UPLOAD_MB: "1" });
    const fd = new FormData();
    fd.append("file", file("scan.pdf", new Uint8Array(MIB + MIB / 2)));
    expect(await readUploadedFiles(await multipart(fd), "file", 1, { maxBytes: 2 * MIB })).toHaveLength(1);

    const big = new FormData();
    big.append("file", file("scan.pdf", new Uint8Array(2 * MIB + 1)));
    const error = await caught(async () => readUploadedFiles(await multipart(big), "file", 1, { maxBytes: 2 * MIB }));
    expect(error).toMatchObject({ code: "too_large", message: "Uploads can be at most 2 MB in total." });
  });

  it("refuses a body over the budget plus multipart overhead without reading it", async () => {
    const { req, cancelled } = streamed([new Uint8Array(10)], { "content-length": String(3 * MIB + 1) });
    const error = await caught(() => readUploadedFiles(req, "file", 1, { maxBytes: 2 * MIB }));
    expect(error.code).toBe("too_large");
    expect(cancelled()).toBe(false);
  });
});

describe("error responses", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serialize an AppError with its status and a Retry-After in whole seconds", async () => {
    const res = jsonError(new AppError("rate_limited", "Slow down.", { retryAfterMs: 1500 }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Slow down." } });
    expect(jsonError(new AppError("not_found", "Nope.")).headers.has("Retry-After")).toBe(false);
  });

  it("turn unexpected errors into a 500 and log them without their message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = toErrorResponse(new TypeError("student Maria Lopez"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal");
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).toContain("TypeError");
    expect(String(log.mock.calls[0][0])).not.toContain("Maria");
  });

  it("pass AppErrors through unlogged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(toErrorResponse(new AppError("closed", "Closed.")).status).toBe(403);
    expect(log).not.toHaveBeenCalled();
  });
});
