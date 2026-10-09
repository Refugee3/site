import { formatPercent } from "@/lib/format";
import { truncateChars } from "@/lib/grading/text";
import type { ItemTally } from "@/lib/grading/item-stats";

/** "Question 3"; the key's own label ("2a", "Q4") follows the word. */
export function questionName(label: string): string {
  return `Question ${label}`;
}

/** "Question 3 — 62.5% missed (3 wrong, 1 blank, 1 partly right, of 8)", with unreadable answers only when there are some. */
export function missedLine(label: string, t: ItemTally): string {
  const parts = [`${t.wrong} wrong`, `${t.blank} blank`, `${t.partly} partly right`];
  if (t.unreadable > 0) parts.push(`${t.unreadable} unreadable`);
  return `${questionName(label)} — ${formatPercent(t.missedTenths)} missed (${parts.join(", ")}, of ${t.judged})`;
}

/** The prompt cut to `max` characters, with an ellipsis when cut; whitespace runs collapse to one space. */
export function shortPrompt(prompt: string, max = 160): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  const cut = truncateChars(text, max);
  return cut.length < text.length ? `${cut.trimEnd()}…` : text;
}

/** The board filtered to the papers that missed an item. */
export function missedHref(assignmentId: string, itemId: string): string {
  return `/teacher/assignments/${assignmentId}?missed=${encodeURIComponent(itemId)}`;
}

/** `?missed=` from the URL: one value, else none (an unknown item id shows the whole board). */
export function parseMissedParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
