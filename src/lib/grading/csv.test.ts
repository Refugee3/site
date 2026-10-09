import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/lib/grading/csv";

describe("csvCell", () => {
  it.each<[string | number | null, string]>([
    [null, '""'],
    ["", '""'],
    [42, '"42"'],
    [7.5, '"7.5"'],
    ["Maria Lopez", '"Maria Lopez"'],
    ['She said "hi"', '"She said ""hi"""'],
    ["line one\nline two, too", '"line one\nline two, too"'],
  ])("%j → %s", (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });

  it.each(["=SUM(A1:A9)", "+1", "-1+2", "@cmd", "\tx", "\rx"])("guards formula-like text %j with a leading quote", (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });

  it("guards formulas that also contain quotes", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
  });

  it("does not guard numbers", () => {
    expect(csvCell(-1)).toBe('"-1"');
  });
});

describe("toCsv", () => {
  it("starts with a BOM and ends every row with CRLF", () => {
    expect(toCsv([["Name", "Points"], ["Maria", 7.5], [null, "=1"]])).toBe('﻿"Name","Points"\r\n"Maria","7.5"\r\n"","\'=1"\r\n');
  });

  it("is just the BOM without rows", () => {
    expect(toCsv([])).toBe("﻿");
  });
});
