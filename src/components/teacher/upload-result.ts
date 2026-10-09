/** What a successful teacher upload (201) returns. */
export interface TeacherUploadResult {
  submissionId: string;
  /** Absolute link to the student's receipt. */
  receiptUrl: string;
}

const RECEIPT_URL_RE = /^https?:\/\/\S+\/r\/[A-Za-z0-9_-]{43}$/;

/** The upload response body, or null when it is not the shape the server promises (so nothing odd gets linked). */
export function parseTeacherUploadResult(json: unknown): TeacherUploadResult | null {
  const body = json as Partial<Record<keyof TeacherUploadResult, unknown>> | null;
  if (typeof body?.submissionId !== "string" || typeof body.receiptUrl !== "string") return null;
  if (!RECEIPT_URL_RE.test(body.receiptUrl)) return null;
  return { submissionId: body.submissionId, receiptUrl: body.receiptUrl };
}
