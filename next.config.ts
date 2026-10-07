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
  // Already in Next's default list; explicit because the app cannot run without the native module.
  serverExternalPackages: ["better-sqlite3"],
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
