import { useEffect } from "react";
import { shouldGuardClick } from "@/lib/client/leave-guard";

/**
 * While `active`, asks before the page is left. Reloading, closing the tab or going to another site gets
 * the browser's own prompt (beforeunload). A click on an in-app link, which Next.js handles as a client
 * navigation without beforeunload, asks `message` in a confirm dialog and is cancelled unless the teacher
 * agrees: the listener runs in the capture phase, before React's, and Next's <Link> does not navigate when
 * the click's default was prevented. The browser's Back button is not covered.
 */
export function useLeaveGuard(active: boolean, message: string): void {
  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!anchor) return;
      const leaves = shouldGuardClick(
        {
          button: event.button,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          defaultPrevented: event.defaultPrevented,
          href: anchor.getAttribute("href") ?? "",
          target: anchor.getAttribute("target"),
          download: anchor.hasAttribute("download"),
        },
        window.location.href,
      );
      if (leaves && !window.confirm(message)) event.preventDefault();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [active, message]);
}
