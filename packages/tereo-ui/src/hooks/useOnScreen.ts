import { useCallback, useEffect, useRef, useState } from "react";

interface UseOnScreenOptions {
  /** Viewport margin applied to the IntersectionObserver root. */
  rootMargin?: string;
  /** When true, the hook stays true after the first intersection (default: true). */
  sticky?: boolean;
}

/**
 * Returns a callback ref + a flag indicating whether the element has entered
 * the viewport. `sticky` (default) keeps it true after the first intersection
 * so expensive side effects (e.g. image fetches) don't thrash as the user
 * scrolls past and back.
 *
 * A callback ref (not RefObject) is returned so the same hook works with any
 * HTMLElement subclass — React typing is contravariant for RefObject.
 */
const useOnScreen = (options?: UseOnScreenOptions) => {
  const [isVisible, setIsVisible] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const rootMargin = options?.rootMargin ?? "200px";
  const sticky = options?.sticky ?? true;

  const ref = useCallback(
    (node: Element | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (!node) return;
      if (typeof IntersectionObserver === "undefined") {
        // SSR / jsdom — treat as visible so nothing breaks.
        setIsVisible(true);
        return;
      }
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            if (sticky) observer.disconnect();
          } else if (!sticky) {
            setIsVisible(false);
          }
        },
        { rootMargin }
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [rootMargin, sticky]
  );

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    []
  );

  return { ref, isVisible };
};

export default useOnScreen;
