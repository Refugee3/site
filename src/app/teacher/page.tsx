import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { AssignmentCard } from "@/components/teacher/assignment-card";
import { DashboardLive } from "@/components/teacher/dashboard-live";
import { QuizMatchAlerts } from "@/components/teacher/matching-answers";
import { NewFromKey } from "@/components/teacher/new-from-key";
import { StrugglingQuestions } from "@/components/teacher/struggling-questions";
import { cx } from "@/components/ui/cx";
import { BookIcon, CheckCircleIcon, ClockIcon, LayersIcon, QuizIcon, SparklesIcon, UsersIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireTeacher } from "@/lib/auth/dal";
import { getDashboardView, getQuizMatchAlerts, getStrugglingQuestions } from "@/lib/services/views";
import type { AssignmentKind } from "@/lib/types";

export const metadata: Metadata = { title: "Assignments" };

const KIND_FILTERS: Array<{ kind: AssignmentKind | null; label: string; href: string }> = [
  { kind: null, label: "All", href: "/teacher" },
  { kind: "homework", label: "Homework", href: "/teacher?type=homework" },
  { kind: "quiz", label: "Quizzes", href: "/teacher?type=quiz" },
];

export default async function TeacherDashboardPage(props: PageProps<"/teacher">) {
  await connection();
  const teacher = await requireTeacher();
  const view = getDashboardView(teacher);
  const { type, struggling } = await props.searchParams;
  const kind: AssignmentKind | null = type === "homework" || type === "quiz" ? type : null;
  const typeQuery = kind ? `type=${kind}` : "";
  const shown = kind ? view.assignments.filter((a) => a.kind === kind) : view.assignments;
  // Polls for every assignment, shown or not, so switching filters never shows stale cards.
  const busy = view.assignments.some((a) => a.progress !== null || a.scans.splitting > 0 || a.keyStatus === "processing");

  const matchAlerts = kind !== "homework" && view.assignments.length > 0 ? getQuizMatchAlerts(teacher) : [];
  const totals = view.assignments.reduce(
    (t, a) => ({
      graded: t.graded + a.counts.graded + a.counts.needs_review,
      toCheck: t.toCheck + a.counts.needs_review,
      grading: t.grading + a.counts.queued + a.counts.grading,
    }),
    { graded: 0, toCheck: 0, grading: 0 },
  );
  const firstName = teacher.displayName.trim().split(/\s+/)[0] || "there";
  const heading = kind === "quiz" ? "Your quizzes" : kind === "homework" ? "Your homework" : `Welcome back, ${firstName}`;

  return (
    <>
      <section
        aria-labelledby="dashboard-heading"
        className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-night-900 via-night-800 to-brand-800 px-6 py-7 text-white shadow-[0_20px_40px_-20px_rgb(20_23_51/0.6)] sm:px-8"
      >
        <div aria-hidden="true" className="pointer-events-none absolute -top-16 -right-10 size-64 rounded-full bg-brand-500/50 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 left-1/3 size-64 rounded-full bg-brand-500/30 blur-3xl" />
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1.5 bg-gold-400" />
        <div className="relative flex flex-col gap-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 id="dashboard-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">{heading}</h1>
              <p className="text-night-300">
                {totals.toCheck > 0
                  ? `${totals.toCheck} ${totals.toCheck === 1 ? "paper is" : "papers are"} waiting for your check.`
                  : totals.grading > 0
                    ? "Grading is under way. This page updates by itself."
                    : "Drop an answer key below to start, or open one of your assignments."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/teacher/assignments/new?kind=quiz"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-night-900 no-underline shadow hover:bg-brand-50"
              >
                <QuizIcon className="text-brand-600" /> New quiz
              </Link>
              <Link
                href="/teacher/assignments/new"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm font-semibold text-white no-underline ring-1 ring-white/25 hover:bg-white/20"
              >
                <BookIcon /> New homework
              </Link>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile icon={<CheckCircleIcon />} label="Papers graded" value={totals.graded} />
            <StatTile icon={<ClockIcon />} label="Waiting for you" value={totals.toCheck} highlight={totals.toCheck > 0} />
            <StatTile icon={<LayersIcon />} label="Grading now" value={totals.grading} />
            <StatTile icon={<UsersIcon />} label="Quiz match alerts" value={matchAlerts.reduce((n, alert) => n + alert.pairs, 0)} highlight={matchAlerts.length > 0} />
          </dl>
        </div>
      </section>

      <NewFromKey defaultKind={kind ?? "homework"} />

      {view.assignments.length > 0 && (
        <div className={cx("grid items-start gap-6", matchAlerts.length > 0 && "xl:grid-cols-[3fr_2fr]")}>
          <StrugglingQuestions
            questions={getStrugglingQuestions(teacher)}
            showAll={struggling === "all"}
            showAllHref={`/teacher?${[typeQuery, "struggling=all"].filter(Boolean).join("&")}`}
            showTopHref={`/teacher${typeQuery ? `?${typeQuery}` : ""}`}
          />
          <QuizMatchAlerts alerts={matchAlerts} />
        </div>
      )}

      {view.assignments.length > 0 && <h2 className="text-xl font-bold tracking-tight">Your homework and quizzes</h2>}

      {view.assignments.length > 0 && (
        <nav aria-label="Filter assignments by type">
          <ul className="flex flex-wrap gap-2">
            {KIND_FILTERS.map((option) => {
              const active = option.kind === kind;
              return (
                <li key={option.label}>
                  <Link
                    href={option.href}
                    scroll={false}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex min-h-11 items-center rounded-full border px-4 text-sm font-medium no-underline sm:min-h-9",
                      active ? "border-brand-600 bg-brand-600 text-white" : "border-line-strong bg-surface text-ink hover:bg-subtle",
                    )}
                  >
                    {option.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      {view.assignments.length === 0 ? (
        <EmptyState
          icon={<SparklesIcon />}
          title="No assignments yet"
          body="Drop an answer key above to start: the AI reads it and asks you anything it needs, then you drop your students' work and watch the results come in. Every paper is graded against your key, and anything the AI isn't sure about is flagged for you to check."
          action={<LinkButton href="/teacher/assignments/new" variant="secondary">Or fill in a form first</LinkButton>}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title={kind === "quiz" ? "No quizzes yet" : "No homework yet"}
          action={
            <LinkButton href={kind === "quiz" ? "/teacher/assignments/new?kind=quiz" : "/teacher/assignments/new"}>
              {kind === "quiz" ? "Create a quiz" : "Create homework"}
            </LinkButton>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((assignment) => (
            <li key={assignment.id} className="flex min-w-0 flex-col [&>article]:flex-1">
              <AssignmentCard assignment={assignment} />
            </li>
          ))}
        </ul>
      )}

      {/* Live: the cards re-render as keys are read and papers graded (polls while busy if the live stream fails). */}
      <DashboardLive busy={busy} />
    </>
  );
}

/** One number in the dashboard banner. */
function StatTile({ icon, label, value, highlight = false }: { icon: ReactNode; label: string; value: number; highlight?: boolean }) {
  return (
    <div className={cx("flex items-center gap-3 rounded-2xl px-3 py-3 ring-1 sm:px-4", highlight ? "bg-white/10 ring-2 ring-gold-400" : "bg-white/5 ring-white/10")}>
      <span className={cx("hidden size-10 shrink-0 place-items-center rounded-xl sm:grid", highlight ? "bg-gold-400 text-night-900" : "bg-white/10 text-white")}>{icon}</span>
      <div className="flex min-w-0 flex-col">
        <dt className="text-xs font-medium leading-tight text-night-300">{label}</dt>
        <dd className="text-2xl font-bold tabular-nums">{value}</dd>
      </div>
    </div>
  );
}
