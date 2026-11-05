import { Badge } from "@/components/ui/badge";
import { FLAG_DEFS } from "@/lib/flags";
import type { FlagCode } from "@/lib/types";

export interface FlagChipsProps {
  flags: FlagCode[];
  /** Show each flag's explanation under its chip instead of only on hover. */
  detailed?: boolean;
}

/** Review flags in amber, informational ones in gray; renders nothing when there are no flags. */
export function FlagChips({ flags, detailed = false }: FlagChipsProps) {
  if (flags.length === 0) return null;
  return (
    <ul className={detailed ? "flex flex-col gap-3" : "flex flex-wrap gap-1.5"}>
      {flags.map((code) => {
        const def = FLAG_DEFS[code];
        const tone = def.severity === "review" ? "warning" : "neutral";
        return (
          <li key={code} className={detailed ? "flex flex-col items-start gap-1" : undefined}>
            <Badge tone={tone} title={detailed ? undefined : def.description}>
              {def.label}
            </Badge>
            {detailed && <p className="text-sm text-muted">{def.description}</p>}
          </li>
        );
      })}
    </ul>
  );
}
