import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { RecentSubmissionNotice } from "@/components/student/recent-submission-notice";
import { UploadForm } from "@/components/student/upload-form";
import { UploadsOffNotice } from "@/components/student/uploads-off-notice";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { PublicPage } from "@/components/ui/public-page";
import { isAppError } from "@/lib/errors";
import { formatShareCode } from "@/lib/format";
import { checkCodeLookup, countCodeLookupMiss } from "@/lib/http/rate-limit";
import { clientIp } from "@/lib/http/request";
import { normalizeShareCode } from "@/lib/ids";
import { studentUploadsEnabled } from "@/lib/services/settings";
import { getStudentUploadView } from "@/lib/services/views";
import type { AssignmentStatus } from "@/lib/types";

export const metadata: Metadata = {
  title: "Hand in your work",
  robots: { index: false, follow: false },
};

const NOT_ACCEPTING: Record<Exclude<AssignmentStatus, "open">, { title: string; body: string }> = {
  draft: {
    title: "This assignment isn't open yet",
    body: "Your teacher hasn't opened it for submissions. Check back later or ask your teacher.",
  },
  closed: {
    title: "This assignment is closed",
    body: "It no longer accepts submissions. Ask your teacher if you still need to hand it in.",
  },
};

export default async function StudentUploadPage(props: PageProps<"/s/[code]">) {
  const { code: requested } = await props.params;
  const code = normalizeShareCode(requested);
  if (!code) notFound();
  if (code !== requested) redirect(`/s/${code}`);

  await connection();
  // Neither looked up nor counted while uploads are off, so the page reveals nothing about which codes exist.
  if (!studentUploadsEnabled()) {
    return (
      <PublicPage>
        <h1 className="text-2xl font-semibold">Hand in your work</h1>
        <UploadsOffNotice />
        <RecentSubmissionNotice code={code} canResubmit={false} />
      </PublicPage>
    );
  }
  // Unknown codes count against the same per-IP lookup limit as /go, so this page is no unthrottled oracle.
  const ip = clientIp(await headers());
  if (!mayLookUp(ip)) {
    return (
      <PublicPage>
        <Alert tone="warning" title="Too many tries from this network">
          Wait a minute, then reload this page.
        </Alert>
      </PublicPage>
    );
  }
  const view = getStudentUploadView(code);
  if (!view) {
    countCodeLookupMiss(ip);
    notFound();
  }
  const closedNotice = view.status === "open" ? null : NOT_ACCEPTING[view.status];

  return (
    <PublicPage>
      <header className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted">
          Code <span className="font-mono">{formatShareCode(view.code)}</span>
        </p>
        <h1 className="text-2xl font-semibold text-balance break-words">{view.title}</h1>
        <p className="text-muted break-words">From {view.teacherName}</p>
      </header>

      {view.instructions && (
        <Card title="Instructions">
          <p className="whitespace-pre-wrap leading-relaxed">{view.instructions}</p>
        </Card>
      )}

      <RecentSubmissionNotice code={view.code} canResubmit={view.accepting} />

      {view.accepting ? (
        <Card title="Hand in your pages">
          <div className="flex flex-col gap-5">
            <Alert tone="info" title="Before you start">
              Write your full name and class period/section at the top of page 1.
            </Alert>
            <UploadForm
              code={view.code}
              uploadUrl={`/api/s/${view.code}/submissions`}
              maxUploadMb={view.maxUploadMb}
              maxFiles={view.maxFiles}
              maxPages={view.maxPages}
            />
          </div>
        </Card>
      ) : (
        closedNotice && (
          <Alert tone="warning" title={closedNotice.title}>
            {closedNotice.body}
          </Alert>
        )
      )}
    </PublicPage>
  );
}

function mayLookUp(ip: string | null): boolean {
  try {
    checkCodeLookup(ip);
    return true;
  } catch (e) {
    if (isAppError(e) && e.code === "rate_limited") return false;
    throw e;
  }
}
