import { readInjectedBranding } from "./readInjected";

/** The injected console-scope app name, or null; core only injects it for console branding. */
export const readConsoleAppName = (): string | null => {
  const branding = readInjectedBranding();
  return branding?.scope === "console" ? (branding.appName ?? null) : null;
};

export const useConsoleBranding = (): { appName: string | null } => ({
  appName: readConsoleAppName(),
});
