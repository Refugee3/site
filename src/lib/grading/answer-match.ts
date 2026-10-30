import { organizeBoard } from "@/lib/grading/board";
import { isCountedStatus, paperOutcomes } from "@/lib/grading/item-stats";
import type { GradingMode, KeyItem, Section, Submission, SubmissionItem } from "@/lib/types";

// "Matching answers" on a quiz: pairs of students whose answers match far more than chance would explain. Students who
// both got a question right agree because they know it, so only matching WRONG answers count as evidence, and a wrong
// answer few others chose counts most. Homework isn't checked: students may work together, and most answers match.
// No AI calls: computed from the stored judgments and the teacher's overrides, like the question stats.

/** At least this many graded papers on the quiz before pairs are compared (rarity needs a class to compare with). */
export const MATCH_MIN_PAPERS = 4;
/** …and the two papers must both have answered at least this many questions. */
export const MATCH_MIN_COMPARED = 4;
/** Share of the questions both answered on which their answers are the same (tenths of a percent: 800 = 80%). */
export const MATCH_MIN_SAME_TENTHS = 800;
/** A wrong answer is rare when at most this share of the papers that answered the question gave it (or 2 papers). */
const RARE_SHARE = 0.25;

export interface MatchStudent {
  submissionId: string;
  name: string | null;
  section: string;
}

export interface SharedWrongAnswer {
  itemId: string;
  label: string;
  answer: string;
  /** Other papers (not these two) with the same answer. */
  others: number;
  /** Few in the class chose it (see RARE_SHARE). */
  rare: boolean;
}

export interface AnswerMatch {
  a: MatchStudent;
  b: MatchStudent;
  /** Questions both answered. */
  compared: number;
  /** …on which they gave the same answer. */
  same: number;
  /** The same wrong answers, in key order. */
  sharedWrong: SharedWrongAnswer[];
  /** "strong": two or more rare wrong answers in common; "possible": one, and at least one other wrong answer. */
  strength: "strong" | "possible";
}

export interface AnswerMatchSummary {
  matches: AnswerMatch[];
  /** Papers compared (graded, or waiting for review). */
  papers: number;
  /** Enough papers to compare (MATCH_MIN_PAPERS). */
  enough: boolean;
}

interface PaperAnswers {
  student: MatchStudent;
  /** Per key item: the normalized answer and whether it was right, or null when not answered. */
  answers: Array<{ key: string; shown: string; correct: boolean } | null>;
}

/** The quiz's current papers compared pairwise; the matches most worth a look first. */
export function findAnswerMatches(
  items: KeyItem[],
  submissions: Submission[],
  sections: Section[],
  resultsBySubmission: Map<string, SubmissionItem[]>,
  scoring: { gradingMode: GradingMode; accuracyWeight: number },
): AnswerMatchSummary {
  const papers: PaperAnswers[] = [];
  for (const group of organizeBoard(submissions, sections)) {
    for (const { current } of group.rows) {
      if (!isCountedStatus(current.status)) continue;
      const outcomes = paperOutcomes(items, resultsBySubmission.get(current.id) ?? [], scoring, current.totalOverrideCenti);
      papers.push({
        student: { submissionId: current.id, name: current.studentName, section: group.label },
        answers: outcomes.map((o, i) => {
          if (!o || o.outcome === "blank" || o.outcome === "unreadable") return null;
          const key = normalizeAnswer(o.studentAnswer, items[i].answerType);
          if (key === "") return null;
          return { key, shown: o.studentAnswer.trim().replace(/\s+/g, " "), correct: o.outcome === "correct" };
        }),
      });
    }
  }
  const enough = papers.length >= MATCH_MIN_PAPERS;
  if (!enough) return { matches: [], papers: papers.length, enough };

  // How many papers gave each answer to each question, and how many answered it.
  const counts = items.map((_, i) => {
    const byAnswer = new Map<string, number>();
    let answered = 0;
    for (const p of papers) {
      const a = p.answers[i];
      if (!a) continue;
      answered++;
      byAnswer.set(a.key, (byAnswer.get(a.key) ?? 0) + 1);
    }
    return { byAnswer, answered };
  });

  const matches: AnswerMatch[] = [];
  for (let x = 0; x < papers.length; x++) {
    for (let y = x + 1; y < papers.length; y++) {
      const p = papers[x];
      const q = papers[y];
      let compared = 0;
      let same = 0;
      const sharedWrong: SharedWrongAnswer[] = [];
      items.forEach((item, i) => {
        const a = p.answers[i];
        const b = q.answers[i];
        if (!a || !b) return;
        compared++;
        if (a.key !== b.key) return;
        same++;
        if (a.correct || b.correct) return;
        const withIt = counts[i].byAnswer.get(a.key) ?? 0;
        sharedWrong.push({
          itemId: item.id, label: item.label, answer: a.shown, others: withIt - 2,
          rare: withIt <= Math.max(2, Math.floor(counts[i].answered * RARE_SHARE)),
        });
      });
      if (compared < MATCH_MIN_COMPARED || same * 1000 < compared * MATCH_MIN_SAME_TENTHS) continue;
      // Evidence: wrong answers few others chose. Two in common is strong; one, with another wrong answer in common, possible.
      const rare = sharedWrong.filter((s) => s.rare).length;
      if (rare < 1 || sharedWrong.length < 2) continue;
      const strength = rare >= 2 ? "strong" : "possible";
      matches.push({ a: p.student, b: q.student, compared, same, sharedWrong, strength });
    }
  }
  matches.sort((m, n) => rank(n) - rank(m) || n.same / n.compared - m.same / m.compared);
  return { matches, papers: papers.length, enough };
}

function rank(m: AnswerMatch): number {
  return (m.strength === "strong" ? 1000 : 0) + m.sharedWrong.filter((s) => s.rare).length * 10 + m.sharedWrong.length;
}

/**
 * An answer as compared: case, spacing and trailing punctuation ignored; a choice answer by its option letter ("b",
 * "(B)", "B. Not expected" → "b"), since mark detection and the AI write it differently.
 */
export function normalizeAnswer(answer: string, answerType: KeyItem["answerType"]): string {
  const text = answer.trim().toLowerCase().replace(/\s+/g, " ");
  if (answerType === "multiple_choice") {
    const letter = /^\(?([a-j])(?:[).:]|\s|$)/.exec(text);
    if (letter) return letter[1];
  }
  return text.replace(/[.,;:!]+$/, "");
}
