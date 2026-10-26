import { useCallback, useSyncExternalStore } from "react";

/** Whether `query` matches now, updated as the viewport changes. */
const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
};

export default useMediaQuery;

/** Below this width the top nav folds into a menu and the sidebar is a drawer. */
export const NARROW_SCREEN = "(max-width: 768px)";
