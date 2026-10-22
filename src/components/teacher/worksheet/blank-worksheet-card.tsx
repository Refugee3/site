import { AutoRefresh } from "@/components/auto-refresh";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { WorksheetView } from "@/lib/services/worksheets";
import { plural } from "../text";
import { summarize } from "./spot-model";
import { SpotEditor } from "./spot-editor";
import { WorksheetActions } from "./worksheet-actions";
import { WorksheetUpload } from "./worksheet-upload";

const DETECTING_POLL_MS = 3000;

/**
 * The Answer key page's "Blank worksheet" card: upload an unanswered copy of the worksheet, check the answer spots found on
 * it, save them. Optional: the key is approved without it, and papers without saved spots are read by the AI as before.
 */
export function BlankWorksheetCard({ assignmentId, view }: { assignmentId: string; view: WorksheetView }) {
  const uploadUrl = `/api/teacher/assignments/${assignmentId}/worksheet`;
  const ws = view.worksheet;
  return (
    <Card title="Blank worksheet (mark detection)">
      <div className="flex flex-col gap-4">
        {!ws && (
          <>
            <p className="text-muted">
              Optional, and free: upload the worksheet as it was handed out, before anyone wrote on it. Each paper is then lined
              up with it, and circles, ticks and filled bubbles are read by measuring the ink the student added next to each
              printed option, not by the AI. Blank answers are found the same way; only written answers are sent to the AI, as
              small crops of the answer space.
            </p>
            <WorksheetUpload uploadUrl={uploadUrl} title="Drop the blank worksheet here" />
          </>
        )}
        {ws?.status === "detecting" && (
          <div className="flex items-start gap-3">
            <Spinner className="mt-0.5 size-6 shrink-0 text-brand-600" />
            <div className="flex flex-col gap-1">
              <p className="font-semibold">Finding the answer spots…</p>
              <p className="text-sm text-muted">
                This blank is a scan, so the AI looks at each page once to find the questions and their options. You check them
                next. This page updates by itself.
              </p>
            </div>
            <AutoRefresh intervalMs={DETECTING_POLL_MS} maxDurationMs={15 * 60_000} />
          </div>
        )}
        {ws?.status === "ready" && <ReadyWorksheet assignmentId={assignmentId} view={view} uploadUrl={uploadUrl} />}
      </div>
    </Card>
  );
}

function ReadyWorksheet({ assignmentId, view, uploadUrl }: { assignmentId: string; view: WorksheetView; uploadUrl: string }) {
  const ws = view.worksheet!;
  const counts = summarize(ws.spots, view.items.map((item) => item.label));
  const source = ws.spotsSource === "text" ? "from the PDF's text" : ws.spotsSource === "ai" ? "by the AI" : "drawn by you";
  return (
    <>
      <p>
        <span className="font-semibold">{ws.filename}</span>
        <span className="text-muted"> · {plural(ws.pageCount, "page")} · </span>
        {counts.used === 0
          ? <span className="text-muted">no answer spots yet</span>
          : (
            <span>
              {plural(counts.used, "question")} read from the marks ({counts.choice} choice, {counts.written} written), found {source}
            </span>
          )}
      </p>
      {ws.note && <Alert tone="warning">{ws.note}</Alert>}
      {view.keyPageCount !== null && view.keyPageCount !== ws.pageCount && (
        <Alert tone="warning">
          The answer key suggests papers have {plural(view.keyPageCount, "page")}, but this blank has {ws.pageCount}. Papers are only
          read from the spots when they have as many pages as the blank.
        </Alert>
      )}
      {ws.confirmedAt === null && ws.spots.length > 0 && (
        <Alert tone="info" title="Check the answer spots, then save">
          Each box should sit on the option letter or word a student would circle, or on the space where the answer is written.
          Papers are read from the spots only once you save them.
        </Alert>
      )}
      {counts.missing.length > 0 && view.items.length > 0 && (
        <p className="text-sm text-muted">
          Read by the AI as before (no spot): {counts.missing.join(", ")}.
        </p>
      )}
      <p className="text-sm text-muted">
        Papers must have {plural(ws.pageCount, "page")}, like this blank; a paper that doesn&apos;t line up with it is read by the AI
        and flagged.
      </p>
      <SpotEditor
        assignmentId={assignmentId}
        pages={ws.pageUrls.map((url, i) => ({ url, width: ws.pageSizes[i]?.width ?? 612, height: ws.pageSizes[i]?.height ?? 792 }))}
        spots={ws.spots}
        items={view.items}
        confirmed={ws.confirmedAt !== null}
      />
      <WorksheetActions assignmentId={assignmentId} hasText={ws.hasText} canAskAi={view.canAskAi} uploadUrl={uploadUrl} />
    </>
  );
}
