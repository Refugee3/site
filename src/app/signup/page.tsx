import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { SignupForm } from "@/components/auth/signup-form";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { PublicPage } from "@/components/ui/public-page";
import { signupPolicy } from "@/lib/auth/accounts";

export const metadata: Metadata = { title: "Create a teacher account" };

export default async function SignupPage() {
  await connection();
  const policy = signupPolicy();

  return (
    <PublicPage>
      <h1 className="text-2xl font-semibold">Create a teacher account</h1>
      {policy === "closed" ? (
        <Alert tone="info" title="Sign-ups are closed">
          This server already has a teacher. To let more teachers join, the administrator sets TEACHER_SIGNUP_CODE and
          shares the code with them.
        </Alert>
      ) : (
        <>
          {policy === "open_first" && (
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
