import { cx } from "@/components/ui/cx";

export interface PdfFrameProps {
  src: string;
  title: string;
  /** 1-based page to open at. */
  page?: number | null;
  className?: string;
}

/** Embeds a same-origin PDF with the browser's viewer, plus a new-tab link for phones that render iframes poorly. */
export function PdfFrame({ src, title, page, className }: PdfFrameProps) {
  const url = src + (page ? `#page=${page}` : "");
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <iframe src={url} title={title} className="h-[70vh] min-h-96 w-full rounded-lg border border-line bg-surface" />
      <a href={url} target="_blank" rel="noopener" className="self-start text-sm">
        Open the PDF in a new tab
      </a>
    </div>
  );
}
