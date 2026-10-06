const BOM = "﻿";
const CRLF = "\r\n";
// Spreadsheet apps evaluate cells that start with these characters as formulas.
const FORMULA_START = /^[=+\-@\t\r]/;

/** One quoted CSV cell; text that a spreadsheet would run as a formula is prefixed with "'". */
export function csvCell(v: string | number | null): string {
  if (v === null) return '""';
  const text = typeof v === "number" ? String(v) : FORMULA_START.test(v) ? `'${v}` : v;
  return `"${text.replace(/"/g, '""')}"`;
}

/** A CSV document with a UTF-8 BOM (so Excel detects the encoding) and CRLF line endings. */
export function toCsv(rows: Array<Array<string | number | null>>): string {
  return BOM + rows.map((row) => row.map(csvCell).join(",") + CRLF).join("");
}
