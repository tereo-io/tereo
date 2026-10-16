import type { QueryClient } from "@tanstack/react-query";

/**
 * Refetch every cached view of services: the list page, the detail pages and
 * the full list the auth admin screens label permissions
 * and roles with.
 */
const invalidateServices = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["services"] }),
    queryClient.invalidateQueries({ queryKey: ["services-infinite"] }),
  ]);

export default invalidateServices;
