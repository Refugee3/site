import { describe, expect, it } from "vitest";
import { cleanName, nameKey, nameSortKey } from "@/lib/grading/names";

describe("cleanName", () => {
  it.each<[string | null, string | null]>([
    [null, null],
    ["", null],
    ["   ", null],
    ["  Maria   Lopez \n", "Maria Lopez"],
    ["MARIA LOPEZ", "Maria Lopez"],
    ["maria lopez", "Maria Lopez"],
    ["MARY-JANE O'BRIEN", "Mary-Jane O'Brien"],
    ["josé álvarez", "José Álvarez"],
    ["Maria de la Cruz", "Maria de la Cruz"],
    ["McDonald, Ian", "McDonald, Ian"],
    ["42", "42"],
  ])("%j → %j", (raw, cleaned) => {
    expect(cleanName(raw)).toBe(cleaned);
  });

  it("caps the name at 120 characters", () => {
    const cleaned = cleanName(`Maria ${"Lopez".repeat(40)}`);
    expect(Array.from(cleaned ?? "")).toHaveLength(120);
  });
});

describe("nameKey", () => {
  it("treats word order, case, accents and punctuation as the same student", () => {
    expect(nameKey("Lopez, Maria")).toBe("lopez maria");
    expect(nameKey("maría lopez")).toBe("lopez maria");
    expect(nameKey("MARIA  LÓPEZ")).toBe("lopez maria");
  });

  it("joins apostrophes and splits hyphens", () => {
    expect(nameKey("Sean O'Brien")).toBe(nameKey("sean obrien"));
    expect(nameKey("Mary-Jane Smith")).toBe(nameKey("Smith, Mary Jane"));
  });

  it("is null without letters", () => {
    expect(nameKey(null)).toBeNull();
    expect(nameKey("")).toBeNull();
    expect(nameKey("123 ?")).toBeNull();
  });

  it("tells different students apart", () => {
    expect(nameKey("Maria Lopez")).not.toBe(nameKey("Mario Lopez"));
  });
});

describe("nameSortKey", () => {
  it.each<[string | null, string]>([
    ["Lopez, Maria", "lopez maria"],
    ["Maria Lopez", "lopez maria"],
    ["Maria de la Cruz Jr.", "cruz maria de la"],
    ["Cruz Jr., Maria", "cruz maria"],
    ["José Álvarez", "alvarez jose"],
    ["Cher", "cher"],
    ["Henry Ford III", "ford henry"],
    ["Jr", "jr"],
    [null, "~"],
    ["???", "~"],
  ])("%j → %j", (name, key) => {
    expect(nameSortKey(name)).toBe(key);
  });

  it("sorts unnamed papers after every name", () => {
    const keys = [nameSortKey(null), nameSortKey("Zoe Young"), nameSortKey("Adam Abbott")];
    expect([...keys].sort()).toEqual(["abbott adam", "young zoe", "~"]);
  });
});
