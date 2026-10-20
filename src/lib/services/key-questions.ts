import { tx } from "@/lib/db/connection";
import { listKeyQuestions, recordKeyQuestionAnswer } from "@/lib/db/repos/key-questions";
import { listKeyItems, updateKey, upsertKeyItems } from "@/lib/db/repos/keys";
import { AppError } from "@/lib/errors";
import { isKeyApproved, keyFingerprint } from "@/lib/grading/key";
import { applyKeyAnswers, LIMITS } from "@/lib/grading/key-questions";
import { truncateChars } from "@/lib/grading/text";
import { requireKey } from "@/lib/services/key-state";
import { saveKey } from "@/lib/services/keys";
import type { Assignment, KeyQuestion } from "@/lib/types";

// The AI's questions about a key it read, answered on the assignment's workspace before the key is approved.

export interface KeyQuestionAnswer {
  id: string;
  /** null (or blank) skips the question. */
  answer: string | null;
}

/**
 * Records the teacher's answers and applies them to the key without an AI call (applyKeyAnswers): missing answers become the
 * teacher's, points are set, everything else goes to the teacher's notes. Only pending questions take an answer; one answered
 * already is left as it is. Like a save, a change to judgment-relevant content starts a new key revision, but the key is not
 * approved by this: the teacher approves it next.
 */
export function answerKeyQuestions(a: Assignment, answers: KeyQuestionAnswer[]): { answered: number; skipped: number; changedItems: number; notes: number } {
  return tx(() => {
    const key = requireKey(a.id);
    if (key.status !== "ready") throw new AppError("invalid_state", "The answer key isn't ready for answers yet.");
    const items = listKeyItems(a.id);
    if (isKeyApproved(key, items.length)) {
      throw new AppError("invalid_state", "The key is already approved. Edit it on the Answer key tab instead.");
    }
    const byId = new Map(listKeyQuestions(a.id).map((q) => [q.id, q]));
    const fresh: KeyQuestion[] = [];
    let skipped = 0;
    for (const { id, answer } of answers) {
      const q = byId.get(id);
      if (!q) throw new AppError("conflict", "The AI's questions changed (the key was read again). Reload the page.");
      if (q.status !== "pending") continue;
      const text = truncateChars((answer ?? "").trim(), LIMITS.answer);
      recordKeyQuestionAnswer(a.id, id, text === "" ? null : text);
      if (text === "") skipped++;
      else fresh.push({ ...q, status: "answered", answer: text });
    }
    if (fresh.length === 0) return { answered: 0, skipped, changedItems: 0, notes: 0 };

    const applied = applyKeyAnswers({ items, teacherNotes: key.teacherNotes, questions: fresh });
    const saved = upsertKeyItems(a.id, applied.items);
    const fingerprint = keyFingerprint(saved, applied.teacherNotes);
    updateKey(a.id, {
      teacherNotes: applied.teacherNotes,
      fingerprint,
      revision: fingerprint === key.fingerprint ? key.revision : key.revision + 1,
    });
    return { answered: fresh.length, skipped, changedItems: applied.changedItemIds.length, notes: applied.notes.length };
  });
}

/**
 * Approves the key exactly as stored (saveKey's approval path, so the same checks apply, including the acknowledgement of
 * AI-proposed answers). `seenUpdatedAt` is the key's updatedAt the teacher looked at: a key changed since is not approved unseen.
 */
export function approveKeyAsIs(a: Assignment, o: { acknowledgeAiProposed: boolean; seenUpdatedAt: number }): ReturnType<typeof saveKey> {
  return tx(() => {
    const key = requireKey(a.id);
    if (key.updatedAt !== o.seenUpdatedAt) {
      throw new AppError("conflict", "The answer key changed since this page showed it. Check it again, then approve it.");
    }
    return saveKey(a, {
      teacherNotes: key.teacherNotes,
      acknowledgeAiProposed: o.acknowledgeAiProposed,
      items: listKeyItems(a.id).map((i) => ({
        id: i.id, label: i.label, groupLabel: i.groupLabel, prompt: i.prompt, answerType: i.answerType, expectedAnswer: i.expectedAnswer,
        acceptableAnswers: i.acceptableAnswers, gradingCriteria: i.gradingCriteria, pointsCenti: i.pointsCenti, partialCredit: i.partialCredit,
        page: i.page,
      })),
    });
  });
}
