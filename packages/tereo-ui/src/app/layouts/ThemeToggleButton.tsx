import { faMoon, faSun } from "@fortawesome/free-solid-svg-icons";
import { IconButton } from "@kosmeo-ui/react";
import { useTheme } from "@/lib/theme";

export const ThemeToggleButton = () => {
  const { resolvedTheme, toggleTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <IconButton
      icon={isDark ? faSun : faMoon}
      variant="primary"
      size="sm"
      shadow={false}
      fullWidth={false}
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    />
  );
};
