/** Shared look of text inputs, textareas and selects; 16 px text stops iOS from zooming on focus. */
export const CONTROL_CLASSES =
  "block w-full min-h-11 rounded-lg border border-line-control bg-surface px-3 py-2 text-base text-ink shadow-xs " +
  "placeholder:text-muted/70 focus:border-brand-600 focus:outline-2 focus:outline-offset-0 focus:outline-brand-600/40 " +
  "disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted " +
  "aria-[invalid=true]:border-danger-600 aria-[invalid=true]:focus:outline-danger-600/40";
