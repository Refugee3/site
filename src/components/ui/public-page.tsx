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

/** The shell of the signed-out pages (login and signup). */
export function PublicPage({ children, width = "narrow" }: PublicPageProps) {
  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center px-4">
          <Link href="/" className="no-underline" aria-label={APP_NAME}>
            <Logo />
          </Link>
        </div>
      </header>
      <main
        className={cx(
          "mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:py-10",
          width === "narrow" ? "max-w-xl" : "max-w-3xl",
        )}
      >
        {children}
      </main>
    </>
  );
}
