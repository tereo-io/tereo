import { BRANDING_STYLE_ID } from "./readInjected";
import { useEffect } from "react";

/** Turns the injected brand colours off while the caller is mounted. */
export const useStockColors = (): void => {
  useEffect(() => {
    const style = document.getElementById(BRANDING_STYLE_ID);
    if (!(style instanceof HTMLStyleElement)) return;
    const previous = style.disabled;
    style.disabled = true;
    return () => {
      style.disabled = previous;
    };
  }, []);
};
