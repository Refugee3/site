import type { GradingEngineChoice } from "@/lib/types";

// Messages about the grading engine shared by the server actions and the pages (client-safe: no server imports).

/** setGradingEngineAction's message once the choice is saved. */
export function engineSavedMessage(engine: GradingEngineChoice): string {
  return engine === "agent"
    ? "Saved. The hosted agent grades from the next paper on; papers already being graded finish as they started."
    : "Saved. The direct API grades from the next paper on; papers already being graded finish as they started.";
}

/** setUpHostedAgentAction's message when setup succeeded. */
export const HOSTED_AGENT_READY = "The hosted agent is ready.";

/** "under a minute" | "{m} min" | "{h} h" | "{h} h {m} min" (whole minutes, rounded down). */
export function formatAgentTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
