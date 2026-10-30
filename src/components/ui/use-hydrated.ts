import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/**
 * False in the server HTML and while hydrating, true once the component's event handlers are attached.
 * Controls whose only effect is a client handler (file pickers) stay disabled until then: React does not
 * replay a file chosen before hydration, so the selection would be silently lost.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
