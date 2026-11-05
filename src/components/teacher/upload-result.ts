/** What a successful teacher upload (201) returns. */
export interface TeacherUploadResult {
  submissionId: string;
}

/** The upload response body, or null when it is not the shape the server promises (so nothing odd gets linked). */
export function parseTeacherUploadResult(json: unknown): TeacherUploadResult | null {
  const body = json as Partial<Record<keyof TeacherUploadResult, unknown>> | null;
  if (typeof body?.submissionId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(body.submissionId)) return null;
  return { submissionId: body.submissionId };
}
