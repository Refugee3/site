import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { Card } from "@/components/ui/card";
import { PublicPage } from "@/components/ui/public-page";

export const metadata: Metadata = { title: "Teacher log in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const { next } = await props.searchParams;
  return (
    <PublicPage>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Teacher log in</h1>
        <p className="text-muted">
          Grade your students&apos; handwritten homework and quizzes against your answer key, and see which questions the
          class is struggling with.
        </p>
      </div>
      <Card>
        <LoginForm next={typeof next === "string" ? next : ""} />
      </Card>
      <p className="text-sm text-muted">
        No account yet? <Link href="/signup">Create a teacher account</Link>.
      </p>
    </PublicPage>
  );
}
