import { now } from "@/lib/clock";
import { one, run } from "@/lib/db/sql";

// Grading capacity settings (migration 18): other computers running Ollama, and the Claude overflow with its monthly spend.

export interface OverflowSettings {
  enabled: boolean;
  /** Papers waiting before extra ones go to Claude. */
  afterPapers: number;
  /** Most the overflow may spend in a calendar month, in whole dollars. */
  monthlyCapUsd: number;
}

export function getOllamaExtraUrls(): string[] {
  const json = one<{ ollama_extra_urls: string | null }>("SELECT ollama_extra_urls FROM app_settings WHERE id = 1")?.ollama_extra_urls ?? null;
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/** Validated by the caller. */
export function setOllamaExtraUrls(urls: string[]): void {
  run("UPDATE app_settings SET ollama_extra_urls = ?, updated_at = ? WHERE id = 1", urls.length === 0 ? null : JSON.stringify(urls), now());
}

export function getOverflowSettings(): OverflowSettings {
  const row = one<{ overflow_enabled: number; overflow_after_papers: number; overflow_monthly_cap_usd: number }>(
    "SELECT overflow_enabled, overflow_after_papers, overflow_monthly_cap_usd FROM app_settings WHERE id = 1",
  )!;
  return { enabled: row.overflow_enabled === 1, afterPapers: row.overflow_after_papers, monthlyCapUsd: row.overflow_monthly_cap_usd };
}

/** Validated by the caller. */
export function setOverflowSettings(s: OverflowSettings): void {
  run(
    `UPDATE app_settings SET overflow_enabled = @enabled, overflow_after_papers = @after, overflow_monthly_cap_usd = @cap, updated_at = @at
     WHERE id = 1`,
    { enabled: s.enabled ? 1 : 0, after: s.afterPapers, cap: s.monthlyCapUsd, at: now() },
  );
}

/** "2026-10": the calendar month of `at` in the server's time zone. */
export function monthKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getOverflowSpend(month: string): { microUsd: number; papers: number } {
  const row = one<{ micro_usd: number; papers: number }>("SELECT micro_usd, papers FROM overflow_spend WHERE month = ?", month);
  return { microUsd: row?.micro_usd ?? 0, papers: row?.papers ?? 0 };
}

export function addOverflowSpend(month: string, microUsd: number, papers: number): void {
  run(
    `INSERT INTO overflow_spend (month, micro_usd, papers) VALUES (@month, @micro, @papers)
     ON CONFLICT (month) DO UPDATE SET micro_usd = micro_usd + @micro, papers = papers + @papers`,
    { month, micro: Math.max(0, Math.round(microUsd)), papers: Math.max(0, papers) },
  );
}

/** Papers (and scans) waiting to be graded now: queued, due, with an approved key or none needed. */
export function countWaitingGradingJobs(at: number): number {
  return one<{ n: number }>(
    `SELECT count(*) AS n FROM jobs j WHERE j.status = 'queued' AND j.run_after <= ? AND j.kind IN ('grade_submission', 'split_scan')`,
    at,
  )!.n;
}
