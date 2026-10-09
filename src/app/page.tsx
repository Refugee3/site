import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { CodeEntryForm, type CodeEntryError } from "@/components/student/code-entry-form";
import { UploadsOffNotice } from "@/components/student/uploads-off-notice";
import { Card } from "@/components/ui/card";
import { PublicPage } from "@/components/ui/public-page";
import { getCurrentTeacher } from "@/lib/auth/dal";
import { studentUploadsEnabled } from "@/lib/services/settings";

export default async function HomePage(props: PageProps<"/">) {
  await connection();
  if (await getCurrentTeacher()) redirect("/teacher");
  const { error } = await props.searchParams;
  const uploadsOn = studentUploadsEnabled();

  return (
    <PublicPage>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Hand in your work</h1>
        {uploadsOn && <p className="text-muted">Enter the code your teacher gave you.</p>}
      </div>
      {uploadsOn ? (
        <Card>
          <CodeEntryForm error={codeEntryError(error)} />
        </Card>
      ) : (
        <UploadsOffNotice />
      )}
      <p className="text-sm text-muted">
        Teacher? <Link href="/login">Log in</Link> or <Link href="/signup">create an account</Link>.
      </p>
    </PublicPage>
  );
}

function codeEntryError(error: string | string[] | undefined): CodeEntryError | null {
  return error === "code" || error === "rate" || error === "server" || error === "off" ? error : null;
}
