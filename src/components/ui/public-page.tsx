import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { Logo } from "./logo";

export const APP_NAME = "DragonGrader";

export interface PublicPageProps {
  children: ReactNode;
  /** "narrow" suits forms; "wide" suits longer reading. */
  width?: "narrow" | "wide";
}

/** The shell of the signed-out pages (login and signup): the navy bar with the wordmark, then the page. */
export function PublicPage({ children, width = "narrow" }: PublicPageProps) {
  return (
    <>
      <header className="bg-brand-600">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center px-4 sm:px-6">
          <Link href="/" className="no-underline" aria-label={APP_NAME}>
            <Logo onDark />
          </Link>
        </div>
      </header>
      <main
        className={cx(
          "mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-10 sm:py-16",
          width === "narrow" ? "max-w-sm" : "max-w-3xl",
        )}
      >
        {children}
      </main>
      <footer className="mx-auto w-full max-w-6xl px-4 py-6 text-xs text-muted sm:px-6">For teachers. Students never sign in.</footer>
    </>
  );
}
