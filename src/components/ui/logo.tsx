import { cx } from "./cx";

/**
 * DragonGrader's wordmark: the name set in the heading serif, "Dragon" bold and "Grader" regular, with a short gold rule
 * under it. White on the navy bar (`onDark`), Drexel Blue elsewhere.
 */
export function Logo({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  return (
    <span className={cx("inline-flex flex-col font-serif text-xl leading-none", onDark ? "text-white" : "text-brand-600", className)}>
      <span>
        <span className="font-bold">Dragon</span>
        <span className="font-normal">Grader</span>
      </span>
      <span aria-hidden="true" className="mt-1 h-0.5 w-8 bg-gold-400" />
    </span>
  );
}
