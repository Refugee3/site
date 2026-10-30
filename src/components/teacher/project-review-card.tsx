import { Card } from "@/components/ui/card";
import { formatPoints } from "@/lib/format";
import type { ProjectReview } from "@/lib/types";

/** What the AI scored or commented on in a project: each criterion with its points (points mode) and comment. */
export function ProjectReviewCard({ review }: { review: ProjectReview }) {
  if (review.criteria.length === 0) return null;
  const points = review.mode === "points";
  return (
    <Card title={points ? "Score by criterion" : "Feedback by part"}>
      <ul className="flex flex-col divide-y divide-line">
        {review.criteria.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-ink">{c.name}</span>
              {points && c.maxCenti !== null && (
                <span className="tabular-nums text-sm font-semibold">
                  {c.earnedCenti === null ? "—" : formatPoints(c.earnedCenti)} / {formatPoints(c.maxCenti)}
                </span>
              )}
            </div>
            {c.comment && <p className="whitespace-pre-wrap text-sm text-muted">{c.comment}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
