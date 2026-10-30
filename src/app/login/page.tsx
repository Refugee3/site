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
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold">Log in</h1>
        <p className="text-sm text-muted">Grade homework and quizzes against your answer key.</p>
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
