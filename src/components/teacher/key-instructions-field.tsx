import { Textarea } from "@/components/ui/textarea";

export const KEY_INSTRUCTIONS_PLACEHOLDER =
  "e.g. Question 3 is one question with three parts: 2 points for setting up the equation, 2 for the work, 1 for the final answer. "
  + "Don't give points for 5c. On 4, units are required.";

/**
 * "Instructions for the AI (optional)": what the teacher writes before uploading the answer key. The AI reads the key with
 * them, so a question is split into the parts and points described, and parts that earn no points are left out of the grade.
 * The text becomes the key's grading instructions, which the AI also follows on every paper.
 */
export const FEEDBACK_INSTRUCTIONS_PLACEHOLDER = "e.g. Analyze each section of the project: what works, what doesn't, and one "
  + "concrete suggestion. End with a two-sentence summary for the student.";

/** `project`: the box for a new project (its mode), where the instructions are what the AI grades or writes from. */
export function KeyInstructionsField(p: {
  id: string; value: string; onChange: (value: string) => void; disabled?: boolean; project?: "points" | "feedback";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={p.id} className="font-medium text-ink">
        {p.project ? "What should the AI grade or write?" : "Instructions for the AI"}{" "}
        <span className="font-normal text-muted">{p.project ? "(required without a rubric)" : "(optional)"}</span>
      </label>
      <p id={`${p.id}-hint`} className="text-sm text-muted">
        {p.project === "feedback"
          ? "Say what you want on each project: an analysis of each part, a summary, strengths and weaknesses, feedback for the student. No points are given."
          : p.project === "points"
            ? "Say what earns points and how many: the parts or criteria and what each is worth. Or drop a rubric below and the AI scores each of its items."
            : <>Write these before you upload the key. Say what to give points for and what not: how a question splits into parts,
              what each part is worth, what doesn&apos;t count. The AI builds the answer key that way, and you check it before any
              paper is graded.</>}
      </p>
      <Textarea
        id={p.id}
        rows={4}
        maxLength={4000}
        value={p.value}
        disabled={p.disabled}
        placeholder={p.project === "feedback" ? FEEDBACK_INSTRUCTIONS_PLACEHOLDER : KEY_INSTRUCTIONS_PLACEHOLDER}
        aria-describedby={`${p.id}-hint`}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </div>
  );
}
