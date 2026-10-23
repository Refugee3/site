import { tx } from "@/lib/db/connection";
import { getRosterText, latestOtherRoster, putRosterText } from "@/lib/db/repos/rosters";
import { AppError } from "@/lib/errors";
import { MAX_ROSTER_ENTRIES, parseRoster, type RosterEntry, rosterToText } from "@/lib/grading/roster";
import type { Assignment } from "@/lib/types";

// The assignment's class list: names read on papers are matched to it (reconcile), and its names are offered to the AI as
// hints when it reads a name crop (never when it reads answers).

const MAX_TEXT = 40_000;

export function getRoster(assignmentId: string): RosterEntry[] {
  const text = getRosterText(assignmentId);
  return text === null ? [] : parseRoster(text);
}

/** The names the AI may be told when it transcribes a name crop. */
export function rosterNameHints(assignmentId: string): string[] {
  return getRoster(assignmentId).map((e) => e.name);
}

/** Saves the pasted class list (tidied: one "Name | Section" per line); "" removes it. Returns how many students it has. */
export function saveRoster(a: Assignment, text: string): number {
  if (text.length > MAX_TEXT) throw new AppError("validation", "The class list is too long.", { fieldErrors: { roster: ["The class list is too long."] } });
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (lines.length > MAX_ROSTER_ENTRIES) {
    const message = `List at most ${MAX_ROSTER_ENTRIES} students.`;
    throw new AppError("validation", message, { fieldErrors: { roster: [message] } });
  }
  const entries = parseRoster(text);
  putRosterText(a.id, rosterToText(entries));
  return entries.length;
}

/** Copies the class list of the teacher's most recently edited other assignment; returns how many students it has. */
export function copyPreviousRoster(a: Assignment): number {
  return tx(() => {
    const previous = latestOtherRoster(a.teacherId, a.id);
    if (!previous) throw new AppError("not_found", "None of your other assignments has a class list yet.");
    const entries = parseRoster(previous.text);
    putRosterText(a.id, rosterToText(entries));
    return entries.length;
  });
}

export interface RosterView {
  text: string;
  count: number;
  /** The teacher's most recent other class list, offered for reuse; null when there is none. */
  previous: { title: string; count: number } | null;
}

export function getRosterView(a: Assignment): RosterView {
  const entries = getRoster(a.id);
  const previous = latestOtherRoster(a.teacherId, a.id);
  return {
    text: rosterToText(entries),
    count: entries.length,
    previous: previous ? { title: previous.title, count: parseRoster(previous.text).length } : null,
  };
}
