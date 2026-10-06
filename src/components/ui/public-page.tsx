import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";

export const APP_NAME = "PDF Auto-Grader";

export interface PublicPageProps {
  children: ReactNode;
  /** "narrow" suits forms and phone-first student pages; "wide" suits longer reading. */
  width?: "narrow" | "wide";
}

/** The shell of the signed-out pages (start page, login, signup, student upload and receipt). */
export function PublicPage({ children, width = "narrow" }: PublicPageProps) {
  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center px-4">
          <Link href="/" className="text-base font-semibold text-ink no-underline">
            {APP_NAME}
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
