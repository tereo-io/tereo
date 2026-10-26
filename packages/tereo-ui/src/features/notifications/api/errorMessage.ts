import type { CoreError } from "@/utils/apiErrors";

export { issuesOf, type CoreError } from "@/utils/apiErrors";

const KNOWN: Record<string, string> = {
  slug_taken: "A connection with this slug already exists on this channel.",
  connection_in_use:
    "Notifications or deliveries still use this connection. Disable it instead.",
  secrets_required:
    "Enter the password again: changing the host, port, security or username needs it.",
};

export const errorMessage = (error: CoreError, fallback: string) => {
  const body = error.response?.data;
  return (
    (body?.error && KNOWN[body.error]) || body?.error_description || fallback
  );
};
