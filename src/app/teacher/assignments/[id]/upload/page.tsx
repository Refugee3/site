import Link from "next/link";
import { connection } from "next/server";
import { ScanList } from "@/components/teacher/scan-list";
import { UploadChooser } from "@/components/teacher/upload-chooser";
import { Alert } from "@/components/ui/alert";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { uploadLabel } from "@/lib/format";
import { getUploadPageView } from "@/lib/services/views";

export default async function UploadPapersPage(props: PageProps<"/teacher/assignments/[id]/upload">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const view = getUploadPageView(assignment);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{view.studentsCanUpload ? "Upload paper copies" : uploadLabel(assignment.kind)}</h2>
        <p className="text-muted">
          Upload the students&apos; work as PDFs, photos, Word or text files. Each paper is graded against the answer key, and you review anything the
          AI flags.
        </p>
      </div>

      {!view.keyApproved && (
        <Alert tone="warning" title="Check the answer key first">
          Papers can be uploaded once the key is checked and saved.{" "}
          <Link href={`/teacher/assignments/${assignment.id}/key`}>Go to the answer key</Link>
        </Alert>
      )}

      <UploadChooser assignmentId={assignment.id} view={view} />
      <ScanList assignmentId={assignment.id} scans={view.scans} />
    </div>
  );
}
