import { OLLAMA_MODEL_PREFIX } from "@/lib/ollama-settings";
import type { OllamaSpeedView, Submission } from "@/lib/types";

// How long grading took, for the review page ("Read: 48 s · Checked: 12 s · Model: gemma3:27b") and the Ollama settings.

/** "48 s", "1 min 5 s", "2 min"; at least "1 s". */
export function formatStepDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** The model's name as the teacher knows it: "ollama:gemma3:27b" → "gemma3:27b". */
export function modelName(aiModel: string): string {
  return aiModel.startsWith(OLLAMA_MODEL_PREFIX) ? aiModel.slice(OLLAMA_MODEL_PREFIX.length) : aiModel;
}

/**
 * "Read: 48 s · Checked: 12 s · Model: gemma3:27b" for a paper whose grading recorded its times; "Checked: not needed" when
 * the program marked every item (and notes are off), so no judge call was made. null when no time was recorded.
 */
export function gradingTimeText(s: Pick<Submission, "readMs" | "judgeMs" | "aiModel">): string | null {
  if (s.readMs === null) return null;
  return [
    `Read: ${formatStepDuration(s.readMs)}`,
    `Checked: ${s.judgeMs === null ? "not needed" : formatStepDuration(s.judgeMs)}`,
    ...(s.aiModel ? [`Model: ${modelName(s.aiModel)}`] : []),
  ].join(" · ");
}

/** Settings → On this computer: "Median of the last 10 papers graded on this computer: 52 s per paper (read 40 s, checked 12 s)." */
export function recentLocalTimeText(recent: OllamaSpeedView["recent"]): string | null {
  if (recent === null) return null;
  const which = recent.papers === 1 ? "the last paper" : `the last ${recent.papers} papers`;
  return `Median of ${which} graded on this computer: ${formatStepDuration(recent.medianMs)} per paper `
    + `(read ${formatStepDuration(recent.medianReadMs)}, checked `
    + `${recent.medianJudgeMs === 0 ? "without a separate step" : formatStepDuration(recent.medianJudgeMs)}).`;
}
