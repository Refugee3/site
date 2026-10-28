import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { SignupForm } from "@/components/auth/signup-form";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { LogoMark } from "@/components/ui/logo";
import { PublicPage } from "@/components/ui/public-page";
import { isFirstSignup, signupPolicy } from "@/lib/auth/accounts";

export const metadata: Metadata = { title: "Create a teacher account" };

export default async function SignupPage() {
  await connection();
  const policy = signupPolicy();

  return (
    <PublicPage>
      <div className="flex flex-col items-start gap-3">
        <LogoMark className="size-12" />
        <h1 className="text-3xl font-bold tracking-tight">Create a teacher account</h1>
        <p className="text-muted">Set up DragonGrader in a minute: your answer keys and grades stay on this server.</p>
      </div>
      {policy === "closed" ? (
        <Alert tone="info" title="Sign-ups are closed">
          This server already has a teacher. To let more teachers join, the administrator sets TEACHER_SIGNUP_CODE and
          shares the code with them.
        </Alert>
      ) : (
        <>
          {isFirstSignup() && (
            <Alert tone="info">You are creating the first teacher account on this server.</Alert>
          )}
          <Card>
            <SignupForm codeRequired={policy === "code_required"} />
          </Card>
        </>
      )}
      <p className="text-sm text-muted">
        Already have an account? <Link href="/login">Log in</Link>.
      </p>
    </PublicPage>
  );
}
