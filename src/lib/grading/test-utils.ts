// Test-only factories for the grading domain's plain data types.
import type { GradingOutput } from "@/lib/ai/schemas";
import { newId } from "@/lib/ids";
import type { ItemJudgment, KeyItem, Section, Submission, SubmissionItem } from "@/lib/types";

export function makeKeyItem(o: Partial<KeyItem> = {}): KeyItem {
  return {
    id: newId(),
    assignmentId: "assignment-1",
    position: 0,
    label: "1",
    groupLabel: "",
    prompt: "",
    answerType: "short_answer",
    expectedAnswer: "",
    acceptableAnswers: [],
    gradingCriteria: "",
    pointsCenti: 100,
    partialCredit: true,
    page: null,
    answerSource: "teacher",
    aiConfidence: null,
    aiNote: "",
    ...o,
  };
}

export function makeJudgment(o: Partial<ItemJudgment> = {}): ItemJudgment {
  return {
    attempt: "complete",
    correctness: "correct",
    legibility: "clear",
    confidence: "high",
    reviewReason: "none",
    studentAnswer: "x = 4",
    pages: [1],
    whatStudentDid: "",
    feedback: "",
    teacherNote: "",
    ...o,
  };
}

export function makeResult(itemId: string, judgment: ItemJudgment | null, overrideCenti: number | null = null): SubmissionItem {
  return { submissionId: "submission-1", itemId, judgment, overrideCenti, overrideFeedback: null, overrideWhatStudentDid: null, updatedAt: 0 };
}

export function makeSection(o: Partial<Section> & Pick<Section, "label" | "canonicalKey">): Section {
  return { id: newId(), assignmentId: "assignment-1", aliases: [], sortOrder: 0, ...o };
}

export function makeSubmission(o: Partial<Submission> = {}): Submission {
  return {
    id: newId(),
    assignmentId: "assignment-1",
    source: "student",
    receiptToken: "token",
    pdfPath: "files/a/submissions/s.pdf",
    originalFilename: "submission.pdf",
    contentSha256: "sha",
    clientUploadId: null,
    byteSize: 100,
    pageCount: 1,
    status: "graded",
    statusNote: null,
    gradingGeneration: 1,
    gradedKeyRevision: 1,
    aiName: null,
    aiNameConfidence: null,
    aiSectionRaw: null,
    aiSectionMatch: null,
    studentName: null,
    nameSource: null,
    nameKey: null,
    nameSortKey: "~",
    sectionId: null,
    sectionKey: null,
    sectionSource: null,
    documentMatch: "matches",
    flags: [],
    overallFeedback: "",
    overallFeedbackEdited: false,
    teacherSummary: "",
    integrityNote: "",
    unmatchedWork: "",
    totalOverrideCenti: null,
    scoreEarnedCenti: null,
    scoreMaxCenti: null,
    completionCenti: null,
    accuracyCenti: null,
    aiModel: null,
    usage: null,
    errorCode: null,
    errorMessage: null,
    gradedAt: null,
    reviewedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...o,
  };
}

type OutputItem = GradingOutput["items"][number];

export function makeOutputItem(ref: string, o: Partial<OutputItem> = {}): OutputItem {
  return {
    ref,
    pages: [1],
    student_answer: "x = 4",
    legibility: "clear",
    attempt: "complete",
    correctness: "correct",
    confidence: "high",
    review_reason: "none",
    what_student_did: "You solved it.",
    feedback: "Nice work.",
    teacher_note: "",
    ...o,
  };
}

/** A clean grading response for `refs`; nested objects are merged shallowly with the overrides. */
export function makeGradingOutput(
  refs: string[],
  o: { student?: Partial<GradingOutput["student"]>; document_check?: Partial<GradingOutput["document_check"]>;
    integrity?: Partial<GradingOutput["integrity"]>; items?: OutputItem[] }
    & Partial<Pick<GradingOutput, "unmatched_work" | "overall_feedback" | "teacher_summary">> = {},
): GradingOutput {
  return {
    student: { name: "Maria Lopez", name_confidence: "high", section_raw: null, section_match: null, multiple_students_detected: false, ...o.student },
    document_check: { match: "matches", pages_appear_missing: false, note: "", ...o.document_check },
    items: o.items ?? refs.map((ref) => makeOutputItem(ref)),
    integrity: { grader_directed_text_found: false, excerpt: "", ...o.integrity },
    unmatched_work: o.unmatched_work ?? "",
    overall_feedback: o.overall_feedback ?? "Good work overall.",
    teacher_summary: o.teacher_summary ?? "",
  };
}
