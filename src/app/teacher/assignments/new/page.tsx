import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { createAssignmentAction } from "@/actions/assignments";
import { AssignmentForm } from "@/components/teacher/assignment-form";
import { Card } from "@/components/ui/card";
import { requireTeacher } from "@/lib/auth/dal";
import { defaultSectionsText } from "@/lib/services/assignments";
import { studentUploadsEnabled } from "@/lib/services/settings";
import type { AssignmentFormInput } from "@/lib/types";

export const metadata: Metadata = { title: "New homework or quiz" };

export default async function NewAssignmentPage(props: PageProps<"/teacher/assignments/new">) {
  await connection();
  const teacher = await requireTeacher();
  // "?kind=quiz" preselects Quiz; Homework otherwise.
  const kind = (await props.searchParams).kind === "quiz" ? "quiz" : "homework";
  const defaults: AssignmentFormInput = {
    title: "",
    kind,
    instructions: "",
    gradingMode: "completion",
    accuracyWeight: 50,
    // Most teachers reuse the same class periods, so start from the latest assignment's list.
    sectionsText: defaultSectionsText(teacher.id),
    maxSubmissions: 500,
    writeNotes: false,
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <Link href="/teacher" className="self-start text-sm">
        ← All assignments
      </Link>
      <h1 className="text-2xl font-semibold">New homework or quiz</h1>
      <p className="text-muted">
        {studentUploadsEnabled()
          ? "After saving you'll add the answer key. Students can't submit until you open the assignment."
          : "After saving you'll add the answer key, then upload the students' papers."}
      </p>
      <Card>
        <AssignmentForm mode="create" action={createAssignmentAction} defaults={defaults} studentsCanUpload={studentUploadsEnabled()} />
      </Card>
    </div>
  );
}
