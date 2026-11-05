/** What a successful scan upload (201) returns. */
export interface ScanUploadResult {
  scanId: string;
  /** `/teacher/assignments/<assignmentId>/scans/<scanId>`: where the teacher checks the split. */
  reviewUrl: string;
}

const REVIEW_URL_RE = /^\/teacher\/assignments\/[0-9a-f-]{36}\/scans\/[0-9a-f-]{36}$/;

/** The upload response body, or null when it is not the shape the server promises (so the page never navigates anywhere odd). */
export function parseScanUploadResult(json: unknown): ScanUploadResult | null {
  const body = json as Partial<Record<keyof ScanUploadResult, unknown>> | null;
  if (typeof body?.scanId !== "string" || typeof body.reviewUrl !== "string") return null;
  if (!REVIEW_URL_RE.test(body.reviewUrl)) return null;
  return { scanId: body.scanId, reviewUrl: body.reviewUrl };
}
