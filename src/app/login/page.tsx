import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { Card } from "@/components/ui/card";
import { LogoMark } from "@/components/ui/logo";
import { PublicPage } from "@/components/ui/public-page";

export const metadata: Metadata = { title: "Teacher log in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const { next } = await props.searchParams;
  return (
    <PublicPage>
      <div className="flex flex-col items-start gap-3">
        <LogoMark className="size-12" />
        <h1 className="text-2xl font-semibold">Welcome to DragonGrader</h1>
        <p className="text-muted">
          Grade your students&apos; handwritten homework and quizzes against your answer key, see which questions the class
          is struggling with, and spot matching answers on quizzes.
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
