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
      <h1 className="text-2xl font-semibold">Teacher log in</h1>
      <Card>
        <LoginForm next={typeof next === "string" ? next : ""} />
      </Card>
      <p className="text-sm text-muted">
        No account yet? <Link href="/signup">Create one</Link>. Students don&apos;t need an account —{" "}
        <Link href="/">enter your assignment code</Link>.
      </p>
    </PublicPage>
  );
}
