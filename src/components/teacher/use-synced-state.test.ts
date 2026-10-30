import { describe, expect, it } from "vitest";
import { nextSynced, type Synced } from "./use-synced-state";

const same = Object.is;

function state(value: string, syncedFrom: string, adoptNext = false): Synced<string> {
  return { value, syncedFrom, adoptNext };
}

describe("nextSynced", () => {
  it("does nothing while the server value is unchanged", () => {
    const prev = state("Ana Lopez", "");
    expect(nextSynced(prev, "", same)).toBe(prev);
  });

  it("follows the server while the input is untouched", () => {
    expect(nextSynced(state("", ""), "Ana L0pez", same)).toEqual(state("Ana L0pez", "Ana L0pez"));
  });

  it("keeps the teacher's unsaved edit when the server value changes under it", () => {
    // Grading finishes while the teacher is typing the name the AI then misreads.
    expect(nextSynced(state("Ana Lopez", ""), "Ana L0pez", same)).toEqual(state("Ana Lopez", "Ana L0pez"));
    // The input is still dirty against the new server value, so the teacher can save the correction.
  });

  it("adopts the stored version after the form's own save, and only once", () => {
    const saved = nextSynced(state("  Ana Lopez ", "", true), "Ana Lopez", same);
    expect(saved).toEqual(state("Ana Lopez", "Ana Lopez"));
    // A later edit is kept again.
    expect(nextSynced({ ...saved, value: "Ana María Lopez" }, "Ana López", same)).toEqual(state("Ana María Lopez", "Ana López"));
  });

  it("uses the comparison it is given", () => {
    const loose = (a: string, b: string) => a.trim() === b.trim();
    const prev = state("x", "3");
    expect(nextSynced(prev, " 3 ", loose)).toBe(prev);
  });
});
