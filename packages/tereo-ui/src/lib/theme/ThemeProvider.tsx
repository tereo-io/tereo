import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocalStorage } from "@kosmeo-ui/react";
import {
  ThemeContext,
  type ResolvedTheme,
  type Theme,
  type ThemeContextValue,
} from "./themeContext";

const getSystemTheme = (): ResolvedTheme =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

interface ThemeProviderProps {
  children: ReactNode;
}

export const ThemeProvider = ({ children }: ThemeProviderProps) => {
  const [storedTheme, setStoredTheme] = useLocalStorage<Theme>(
    "tereo-theme",
    "system"
  );
  const theme: Theme = storedTheme ?? "system";

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: setStoredTheme,
      toggleTheme: () =>
        setStoredTheme(resolvedTheme === "dark" ? "light" : "dark"),
    }),
    [theme, resolvedTheme, setStoredTheme]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};
