import type { ReactNode, SVGProps } from "react";
import { cx } from "./cx";

// Line icons drawn on a 24 × 24 grid with a 2 px round stroke in the current text color. Decorative unless a `title` is
// given: the text next to them carries the meaning.

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { title?: string };

function icon(paths: ReactNode, name: string) {
  function Icon({ className, title, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={title ? undefined : true}
        role={title ? "img" : undefined}
        focusable="false"
        className={cx("size-5 shrink-0", className)}
        {...props}
      >
        {title && <title>{title}</title>}
        {paths}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const HomeIcon = icon(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>, "HomeIcon");
export const BookIcon = icon(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></>, "BookIcon");
export const QuizIcon = icon(<><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 3.5V5h6V3.5" /><path d="m9 12 2 2 4-4" /><path d="M9 17h6" /></>, "QuizIcon");
export const SettingsIcon = icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>, "SettingsIcon");
export const LogOutIcon = icon(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>, "LogOutIcon");
export const UploadIcon = icon(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></>, "UploadIcon");
export const KeyIcon = icon(<><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 8.8-8.8" /><path d="m16 7 3 3" /><path d="m19 4 2 2" /></>, "KeyIcon");
export const LayersIcon = icon(<><path d="m12 2 10 5-10 5L2 7z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></>, "LayersIcon");
export const ChartIcon = icon(<><path d="M3 3v18h18" /><path d="M8 17v-5" /><path d="M13 17V8" /><path d="M18 17v-9" /></>, "ChartIcon");
export const LightbulbIcon = icon(<><path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z" /></>, "LightbulbIcon");
export const CheckCircleIcon = icon(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>, "CheckCircleIcon");
export const AlertIcon = icon(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>, "AlertIcon");
export const ClockIcon = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, "ClockIcon");
export const UsersIcon = icon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1a4 4 0 0 1 0 7.8" /></>, "UsersIcon");
export const FlameIcon = icon(<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.4 1.4 1.3 2.8 2.5 2.8z" />, "FlameIcon");
export const SparklesIcon = icon(<><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>, "SparklesIcon");
export const ArrowRightIcon = icon(<><path d="M5 12h14" /><path d="m13 5 7 7-7 7" /></>, "ArrowRightIcon");
export const ArrowLeftIcon = icon(<><path d="M19 12H5" /><path d="m11 19-7-7 7-7" /></>, "ArrowLeftIcon");
export const PlusIcon = icon(<><path d="M12 5v14" /><path d="M5 12h14" /></>, "PlusIcon");
export const FileIcon = icon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h5" /></>, "FileIcon");
export const SearchIcon = icon(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, "SearchIcon");
