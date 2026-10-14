import type { QueryClient } from "@tanstack/react-query";

/**
 * Refetch every cached view of services: the list page, the detail pages, the
 * access inbox and the full list the auth admin screens label permissions
 * and roles with.
 */
const invalidateServices = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["services"] }),
    queryClient.invalidateQueries({ queryKey: ["services-infinite"] }),
    queryClient.invalidateQueries({ queryKey: ["service-access-infinite"] }),
  ]);

export default invalidateServices;
