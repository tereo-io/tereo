import { ThemeContext, type ThemeContextValue } from "./themeContext";
import { useContext } from "react";

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
};
