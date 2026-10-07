/** A click on a link, as the leave guard reads it from the DOM event and the `<a>` it landed on. */
export interface LinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /** The link's `href` attribute as written (relative or absolute). */
  href: string;
  /** The link's `target` attribute, or null without one. */
  target: string | null;
  /** The link has a `download` attribute. */
  download: boolean;
}

/**
 * Whether a link click leaves the current page in this tab, through a Next.js client navigation or a
 * same-origin page load, so unsaved work on the page would be lost. Not guarded: clicks that open another
 * tab or window (modifier keys, middle button, `target`), downloads, jumps within the page (only the hash
 * changes), links to other sites and non-web schemes (the browser's own beforeunload prompt covers a page
 * load), and clicks something else already handled.
 */
export function shouldGuardClick(click: LinkClick, currentUrl: string): boolean {
  if (click.defaultPrevented || click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (click.target && click.target.toLowerCase() !== "_self") return false;
  if (click.download) return false;

  let from: URL;
  let to: URL;
  try {
    from = new URL(currentUrl);
    to = new URL(click.href, from);
  } catch {
    return false;
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  if (to.origin !== from.origin) return false;
  return to.pathname !== from.pathname || to.search !== from.search;
}
