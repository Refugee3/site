/** A PNG generated from a stored file for the signed-in teacher: cached by their browser only, never sniffed. */
export function pngResponse(png: Uint8Array): Response {
  const body = png.buffer instanceof ArrayBuffer ? (png as Uint8Array<ArrayBuffer>) : new Uint8Array(png);
  return new Response(body, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
