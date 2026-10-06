import { connection } from "next/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { PdfFrame } from "@/components/pdf-frame";
import { KeyEditor } from "@/components/teacher/key-editor";
import { KeyUpload } from "@/components/teacher/key-upload";
import { RetryExtractionButton } from "@/components/teacher/retry-extraction-button";
import { plural } from "@/components/teacher/text";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { LinkButton } from "@/components/ui/link-button";
import { Spinner } from "@/components/ui/spinner";
import { requireOwnedAssignment } from "@/lib/auth/dal";
import { isKeyApproved } from "@/lib/grading/key";
import { getKeyEditorView } from "@/lib/services/views";
import type { Assignment, KeyEditorView } from "@/lib/types";

const PROCESSING_POLL_MS = 3000;

const REPLACE_CONFIRM = "Upload this PDF as the new key? The AI reads it and every current item is replaced.";

const LOCKED_NOTE =
  "Papers have already been graded with this key, so its PDF can't be replaced or read again (that would replace every item). Edit the items instead.";

export default async function AnswerKeyPage(props: PageProps<"/teacher/assignments/[id]/key">) {
  await connection();
  const { id } = await props.params;
  const { assignment } = await requireOwnedAssignment(id);
  const view = getKeyEditorView(assignment);
  const { key, items } = view;
  const buildManually = (await props.searchParams).manual === "1";

  if (key.status === "processing") return <Processing view={view} />;

  const showEditor = key.status === "ready" || items.length > 0 || buildManually;
  const uploadUrl = `/api/teacher/assignments/${assignment.id}/key`;

  return (
    <div className="flex flex-col gap-6">
      {key.status === "empty" && !buildManually && <AddKey uploadUrl={uploadUrl} />}
      {key.status === "failed" && <Failed assignmentId={assignment.id} view={view} uploadUrl={uploadUrl} buildManually={buildManually} />}

      {showEditor && (
        <>
          {key.status === "ready" && !isKeyApproved(key, items.length) && (
            <Alert tone="warning" title="Check the key, then save to approve it">
              Papers are graded only against an approved key. Amber items are ones the AI was unsure about.
            </Alert>
          )}
          {key.aiNotes && (
            <Alert tone="info" title="Notes from the AI">
              <p className="whitespace-pre-wrap">{key.aiNotes}</p>
            </Alert>
          )}
          <EditorWithPdf assignment={assignment} view={view} />
          {key.status === "ready" && key.sourcePdfPath && <ReplaceKey assignmentId={assignment.id} view={view} uploadUrl={uploadUrl} />}
        </>
      )}
    </div>
  );
}

function Processing({ view }: { view: KeyEditorView }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex items-start gap-3">
          <Spinner className="mt-0.5 size-6 text-brand-600" />
          <div className="flex flex-col gap-1">
            <p className="text-lg font-semibold">Reading your answer key…</p>
            <p className="text-muted">
              The AI is listing every question with its answer for you to check. This usually takes a minute or two, and
              this page updates by itself.
            </p>
          </div>
        </div>
      </Card>
      {view.keyPdfUrl && <PdfFrame src={view.keyPdfUrl} title="Answer key PDF" />}
      <AutoRefresh intervalMs={PROCESSING_POLL_MS} />
    </div>
  );
}

function AddKey({ uploadUrl }: { uploadUrl: string }) {
  return (
    <Card title="Add the answer key">
      <div className="flex flex-col gap-4">
        <p className="text-muted">
          Upload the key as a PDF: typed or handwritten, a filled-in worksheet, a list of answers or a rubric. The AI
          lists every question with its answer, and you check the list before any paper is graded.
        </p>
        <KeyUpload uploadUrl={uploadUrl} disabled={false} />
        <p className="text-sm text-muted">No PDF? You can type the key in yourself instead.</p>
        <LinkButton href="?manual=1" variant="secondary" className="self-start">
          Build the key manually
        </LinkButton>
      </div>
    </Card>
  );
}

function Failed(props: { assignmentId: string; view: KeyEditorView; uploadUrl: string; buildManually: boolean }) {
  const { assignmentId, view, uploadUrl, buildManually } = props;
  const canRetry = view.key.sourcePdfPath !== null && !view.locked;
  return (
    <Card title="The answer key couldn't be read">
      <div className="flex flex-col gap-4">
        <Alert tone="danger">
          <p className="whitespace-pre-wrap">{view.key.errorMessage ?? "The AI could not turn this PDF into a list of items."}</p>
        </Alert>
        {view.locked && <p className="text-sm text-muted">{LOCKED_NOTE}</p>}
        <div className="flex flex-wrap items-start gap-3">
          {canRetry && <RetryExtractionButton assignmentId={assignmentId} label="Try again" />}
          <KeyUpload
            uploadUrl={uploadUrl}
            disabled={view.locked}
            label="Upload a different PDF"
            variant="secondary"
            confirmText={view.items.length > 0 ? REPLACE_CONFIRM : undefined}
          />
          {view.items.length === 0 && !buildManually && (
            <LinkButton href="?manual=1" variant="secondary">
              Build the key manually
            </LinkButton>
          )}
        </div>
      </div>
    </Card>
  );
}

function EditorWithPdf({ assignment, view }: { assignment: Assignment; view: KeyEditorView }) {
  const { key, items, keyPdfUrl } = view;
  return (
    <div className={cx("grid gap-6", keyPdfUrl && "xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
      {keyPdfUrl && (
        <div className="flex flex-col gap-2 xl:sticky xl:top-4 xl:self-start">
          <p className="text-sm text-muted">
            {key.sourceFilename ?? "Answer key"}
            {key.sourcePageCount !== null && ` · ${plural(key.sourcePageCount, "page")}`}
          </p>
          <PdfFrame src={keyPdfUrl} title="Answer key PDF" />
        </div>
      )}
      <KeyEditor
        assignmentId={assignment.id}
        assignmentStatus={assignment.status}
        items={items}
        teacherNotes={key.teacherNotes}
        version={key.updatedAt}
        approved={isKeyApproved(key, items.length)}
        gradedCount={view.gradedCount}
      />
    </div>
  );
}

function ReplaceKey({ assignmentId, view, uploadUrl }: { assignmentId: string; view: KeyEditorView; uploadUrl: string }) {
  return (
    <Card title="Replace the key PDF">
      <div className="flex flex-col gap-4">
        {view.locked ? (
          <p className="text-sm text-muted">{LOCKED_NOTE}</p>
        ) : (
          <p className="text-sm text-muted">
            Uploading a new PDF, or reading this one again, replaces every item above, including your edits. Your notes
            for grading are kept.
          </p>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <KeyUpload
            uploadUrl={uploadUrl}
            disabled={view.locked}
            label="Upload a new key PDF"
            variant="secondary"
            confirmText={REPLACE_CONFIRM}
          />
          {!view.locked && (
            <RetryExtractionButton
              assignmentId={assignmentId}
              label="Read this PDF again"
              variant="secondary"
              confirmText="Read the key PDF again? This replaces every item, including your edits."
            />
          )}
        </div>
      </div>
    </Card>
  );
}
