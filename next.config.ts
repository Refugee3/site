import type { NextConfig } from "next";

/** Hosts allowed to invoke server actions besides our own; only needed behind a proxy that rewrites Host. */
function allowedOrigins(): string[] | undefined {
  const hosts = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Receipt links carry tokens; keep them out of every cross-origin Referer. Not "no-referrer": under it,
  // browsers send "Origin: null" on plain form posts, and Next then rejects server-action forms submitted
  // before hydration (login, logout, delete) as cross-origin.
  { key: "Referrer-Policy", value: "same-origin" },
  // Our own pages embed PDFs in same-origin iframes.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // No object-src 'none': Chromium's PDF viewer counts as plugin content and would blank the PDF iframes.
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; form-action 'self'" },
  // The camera stays allowed for the "Take photos" upload button.
  { key: "Permissions-Policy", value: "microphone=(), geolocation=()" },
  { key: "X-Robots-Tag", value: "noindex" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // pdf.js loads its worker and data files from its own package at run time, and @napi-rs/canvas is a native module: both
  // stay out of the bundle (Ollama engine: PDF pages → images). The database is Node's built-in node:sqlite, which, like
  // every node: module, is never bundled.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  // The page-rendering worker (src/lib/omr/render-pool.ts) is loaded by path at run time, never bundled; this keeps it in
  // the server's file traces too.
  outputFileTracingIncludes: { "/**": ["./workers/**"] },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
      allowedOrigins: allowedOrigins(),
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
