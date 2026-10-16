import type { QueryClient } from "@tanstack/react-query";

/** Refetch the list page and every integration detail. */
const invalidateIntegrations = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["integrations"] }),
    queryClient.invalidateQueries({ queryKey: ["integrations-infinite"] }),
  ]);

export default invalidateIntegrations;
