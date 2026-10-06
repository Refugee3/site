"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Hides its (server-rendered) children on the review page, where the teacher moves from paper to paper and
 * the sharing and lifecycle controls would only push the paper down the screen.
 */
export function HiddenWhileReviewing({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return /\/submissions\/[^/]+$/.test(pathname) ? null : children;
}
