import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { CodeEntryForm } from "@/components/student/code-entry-form";
import { Card } from "@/components/ui/card";
import { PublicPage } from "@/components/ui/public-page";
import { getCurrentTeacher } from "@/lib/auth/dal";

export default async function HomePage(props: PageProps<"/">) {
  await connection();
  if (await getCurrentTeacher()) redirect("/teacher");
  const { error } = await props.searchParams;

  return (
    <PublicPage>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Hand in your work</h1>
        <p className="text-muted">Enter the code your teacher gave you.</p>
      </div>
      <Card>
        <CodeEntryForm invalid={error === "code"} />
      </Card>
      <p className="text-sm text-muted">
        Teacher? <Link href="/login">Log in</Link> or <Link href="/signup">create an account</Link>.
      </p>
    </PublicPage>
  );
}
