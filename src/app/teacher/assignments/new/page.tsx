import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { createAssignmentAction } from "@/actions/assignments";
import { AssignmentForm } from "@/components/teacher/assignment-form";
import { Card } from "@/components/ui/card";
import { requireTeacher } from "@/lib/auth/dal";
import { defaultSectionsText } from "@/lib/services/assignments";
import type { AssignmentFormInput } from "@/lib/types";

export const metadata: Metadata = { title: "New assignment" };

export default async function NewAssignmentPage() {
  await connection();
  const teacher = await requireTeacher();
  const defaults: AssignmentFormInput = {
    title: "",
    instructions: "",
    gradingMode: "completion",
    accuracyWeight: 50,
    // Most teachers reuse the same class periods, so start from the latest assignment's list.
    sectionsText: defaultSectionsText(teacher.id),
    maxSubmissions: 500,
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <Link href="/teacher" className="self-start text-sm">
        ← All assignments
      </Link>
      <h1 className="text-2xl font-semibold">New assignment</h1>
      <p className="text-muted">
        After saving you&apos;ll add the answer key. Students can&apos;t submit until you open the assignment.
      </p>
      <Card>
        <AssignmentForm mode="create" action={createAssignmentAction} defaults={defaults} />
      </Card>
    </div>
  );
}
