import Link from "next/link";
import { connection } from "next/server";
import { BulkUpload } from "@/components/teacher/bulk-upload";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { getConfig } from "@/lib/config";
import { isKeyApproved } from "@/lib/grading/key";
import { getKeyEditorView } from "@/lib/services/views";

const MIB = 1_048_576;

export default async function UploadPapersPage(props: PageProps<"/teacher/assignments/[id]/upload">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const { key, items } = getKeyEditorView(assignment);
  const approved = isKeyApproved(key, items.length);
  const { maxUploadBytes, maxPages } = getConfig();

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">Upload paper copies</h2>
        <p className="text-muted">
          Scan each student&apos;s paper into its own PDF (one PDF = one student). They are graded like papers students hand
          in, whether or not the assignment is open. Each upload gives you the student&apos;s receipt link, where they
          see their feedback once you release it.
        </p>
      </div>

      {!approved && (
        <Alert tone="warning" title="Check the answer key first">
          Papers can be uploaded once the key is checked and saved.{" "}
          <Link href={`/teacher/assignments/${assignment.id}/key`}>Go to the answer key</Link>
        </Alert>
      )}

      <Card>
        <BulkUpload uploadUrl={`/api/teacher/assignments/${assignment.id}/submissions`} disabled={!approved} />
      </Card>
      <p className="text-sm text-muted">
        Each PDF can be up to {maxUploadBytes / MIB} MB and {maxPages} pages. A whole-class scan in one PDF can&apos;t be
        split into students here; scan each paper separately.
      </p>
    </div>
  );
}
