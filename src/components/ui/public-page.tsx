import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { ChartIcon, CheckCircleIcon, FileIcon, UsersIcon } from "./icons";
import { Logo } from "./logo";

export const APP_NAME = "DragonGrader";

export interface PublicPageProps {
  children: ReactNode;
  /** "narrow" suits forms; "wide" suits longer reading. */
  width?: "narrow" | "wide";
}

const FEATURES: Array<{ icon: ReactNode; title: string; text: string }> = [
  { icon: <FileIcon />, title: "Reads any handwriting", text: "Drop a scan of the whole class; each paper is found and graded." },
  { icon: <CheckCircleIcon />, title: "Circles measured, not guessed", text: "With a blank worksheet, the marks students made decide the answer." },
  { icon: <ChartIcon />, title: "See where the class struggles", text: "Questions most students missed, across all your work." },
  { icon: <UsersIcon />, title: "Matching answers on quizzes", text: "Students who share unusual wrong answers are flagged for a look." },
];

/** The shell of the signed-out pages (login and signup): the brand panel beside the form on computers, the form alone on phones. */
export function PublicPage({ children, width = "narrow" }: PublicPageProps) {
  return (
    <div className="flex min-h-full flex-1">
      <aside className="relative hidden w-[44%] max-w-xl flex-col justify-between overflow-hidden bg-gradient-to-br from-night-900 via-night-800 to-brand-800 p-10 text-white lg:flex">
        <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-16 size-80 rounded-full bg-brand-500/50 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -left-16 size-80 rounded-full bg-brand-500/30 blur-3xl" />
        <div aria-hidden="true" className="absolute inset-y-0 right-0 w-1.5 bg-gold-400" />
        <Link href="/" className="relative no-underline" aria-label={APP_NAME}>
          <Logo onDark className="text-xl" />
        </Link>
        <div className="relative flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <p className="text-3xl font-bold leading-tight tracking-tight">Grade a whole stack of papers while you make coffee.</p>
            <p className="text-night-300">Your answer key, your students&apos; handwriting, graded in minutes.</p>
          </div>
          <ul className="flex flex-col gap-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-gold-400">{f.icon}</span>
                <span className="flex flex-col">
                  <span className="font-semibold">{f.title}</span>
                  <span className="text-sm text-night-300">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-night-300">For teachers. Students never sign in.</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-line bg-surface lg:hidden">
          <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center px-4">
            <Link href="/" className="no-underline" aria-label={APP_NAME}>
              <Logo />
            </Link>
          </div>
        </header>
        <main
          className={cx(
            "mx-auto flex w-full flex-1 flex-col justify-center gap-6 px-4 py-8 sm:py-12",
            width === "narrow" ? "max-w-md" : "max-w-3xl",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
