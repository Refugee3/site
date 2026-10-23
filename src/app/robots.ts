import type { MetadataRoute } from "next";

// Nothing here is meant to be found by search engines: the app is for signed-in teachers only.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
