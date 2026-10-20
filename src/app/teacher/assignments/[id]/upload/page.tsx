import Link from "next/link";
import { connection } from "next/server";
import { ScanList } from "@/components/teacher/scan-list";
import { UploadChooser } from "@/components/teacher/upload-chooser";
import { Alert } from "@/components/ui/alert";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { getUploadPageView } from "@/lib/services/views";

export default async function UploadPapersPage(props: PageProps<"/teacher/assignments/[id]/upload">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const view = getUploadPageView(assignment);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">Upload students&apos; work</h2>
        <p className="text-muted">
          Upload each student&apos;s paper as a PDF, photo, Word or text file, or one scan of the whole stack. Each paper is
          graded against your answer key, and anything the AI isn&apos;t sure about is flagged for you to check on the
          Results tab.
        </p>
      </div>

      {!view.keyApproved && (
        <Alert tone="warning" title="First, add and approve the answer key">
          Papers can be uploaded once the key is saved and approved (step 1).{" "}
          <Link href={`/teacher/assignments/${assignment.id}/key`}>Go to the answer key</Link>
        </Alert>
      )}

      <UploadChooser assignmentId={assignment.id} view={view} />
      <ScanList assignmentId={assignment.id} scans={view.scans} />
    </div>
  );
}
