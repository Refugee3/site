import type { MetadataRoute } from "next";

// Nothing here is meant to be found by search engines: share codes and receipt links are private.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
