import Link from "next/link";
import { cx } from "@/components/ui/cx";
import type { BoardFilter, StatusCounts } from "@/lib/types";
import { BOARD_FILTERS, boardHref } from "./board-helpers";

export interface BoardFiltersProps {
  assignmentId: string;
  filter: BoardFilter;
  counts: StatusCounts;
}

/** Status counters that double as filters; "Needs review" is highlighted while it has papers. */
export function BoardFilters({ assignmentId, filter, counts }: BoardFiltersProps) {
  return (
    <nav aria-label="Filter papers by status">
      <ul className="flex flex-wrap gap-2">
        {BOARD_FILTERS.map((option) => {
          const count = option.count(counts);
          const active = option.filter === filter;
          const urgent = option.filter === "needs_review" && count > 0;
          return (
            <li key={option.filter}>
              <Link
                href={boardHref(assignmentId, option.filter)}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium no-underline sm:min-h-9",
                  active && "border-brand-600 bg-brand-600 text-white",
                  !active && urgent && "border-warning-200 bg-warning-50 text-warning-800 hover:bg-warning-200/50",
                  !active && !urgent && "border-line-strong bg-surface text-ink hover:bg-subtle",
                )}
              >
                {option.label}
                <span className="tabular-nums">{count}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
