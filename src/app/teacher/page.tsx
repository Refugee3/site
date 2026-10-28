import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { AssignmentTable } from "@/components/teacher/assignment-table";
import { boardHref } from "@/components/teacher/board-helpers";
import { DashboardLive } from "@/components/teacher/dashboard-live";
import { NewFromKey } from "@/components/teacher/new-from-key";
import { StrugglingQuestions } from "@/components/teacher/struggling-questions";
import { plural } from "@/components/teacher/text";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/link-button";
import { requireTeacher } from "@/lib/auth/dal";
import { getDashboardView, getQuizMatchAlerts, getStrugglingQuestions } from "@/lib/services/views";
import type { AssignmentKind } from "@/lib/types";

export const metadata: Metadata = { title: "Assignments" };

const HEADINGS: Record<"all" | AssignmentKind, string> = { all: "Assignments", homework: "Homework", quiz: "Quizzes" };

export default async function TeacherDashboardPage(props: PageProps<"/teacher">) {
  await connection();
  const teacher = await requireTeacher();
  const view = getDashboardView(teacher);
  const { type, struggling } = await props.searchParams;
  const kind: AssignmentKind | null = type === "homework" || type === "quiz" ? type : null;
  const typeQuery = kind ? `type=${kind}` : "";
  const shown = kind ? view.assignments.filter((a) => a.kind === kind) : view.assignments;
  // Polls for every assignment, shown or not, so switching filters never shows a stale table.
  const busy = view.assignments.some((a) => a.progress !== null || a.scans.splitting > 0 || a.keyStatus === "processing");
  const matchAlerts = kind !== "homework" && view.assignments.length > 0 ? getQuizMatchAlerts(teacher) : [];

  const graded = shown.reduce((n, a) => n + a.counts.graded + a.counts.needs_review, 0);
  const waiting = shown.filter((a) => a.counts.needs_review > 0);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold">{HEADINGS[kind ?? "all"]}</h1>
          <p className="text-sm text-muted">
            {plural(shown.length, kind === "quiz" ? "quiz" : kind === "homework" ? "homework" : "assignment", kind === "quiz" ? "quizzes" : kind === "homework" ? "homework" : "assignments")}
            {" · "}
            {plural(graded, "paper")} graded
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/teacher/assignments/new?kind=quiz" variant={kind === "quiz" ? "primary" : "secondary"}>New quiz</LinkButton>
          <LinkButton href="/teacher/assignments/new" variant={kind === "quiz" ? "secondary" : "primary"}>New homework</LinkButton>
        </div>
      </div>

      {(waiting.length > 0 || matchAlerts.length > 0) && (
        <section aria-labelledby="attention-heading" className="border-l-4 border-gold-400 bg-surface px-4 py-3">
          <h2 id="attention-heading" className="text-base font-semibold">Needs your attention</h2>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {waiting.map((a) => (
              <li key={a.id}>
                <Link href={boardHref(a.id, "needs_review")}>
                  {plural(a.counts.needs_review, "paper")} to check in {a.title}
                </Link>
              </li>
            ))}
            {matchAlerts.map((alert) => (
              <li key={alert.assignmentId}>
                <Link href={`/teacher/assignments/${alert.assignmentId}#matching-answers`}>
                  {plural(alert.pairs, "pair")} of students with matching answers in {alert.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.assignments.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          body="Add an answer key below to start. The AI reads it and asks you anything it needs; then upload your students' work and the grades come in. Anything the AI isn't sure about is flagged for you to check."
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
        <AssignmentTable assignments={shown} />
      )}

      <NewFromKey defaultKind={kind ?? "homework"} />

      {view.assignments.length > 0 && (
        <StrugglingQuestions
          questions={getStrugglingQuestions(teacher)}
          showAll={struggling === "all"}
          showAllHref={`/teacher?${[typeQuery, "struggling=all"].filter(Boolean).join("&")}`}
          showTopHref={`/teacher${typeQuery ? `?${typeQuery}` : ""}`}
        />
      )}

      {/* Live: the table re-renders as keys are read and papers graded (polls while busy if the live stream fails). */}
      <DashboardLive busy={busy} />
    </>
  );
}
