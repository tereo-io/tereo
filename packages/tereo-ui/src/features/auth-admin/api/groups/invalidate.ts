import type { QueryClient } from "@tanstack/react-query";

/** A group changed: its page, every list, and what is derived from it. */
export const invalidateGroups = async (
  queryClient: QueryClient,
  groupId?: string
) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["groups-infinite"] }),
    queryClient.invalidateQueries({
      queryKey: groupId ? ["groups", groupId] : ["groups"],
    }),
    // Members and roles change what a user holds.
    queryClient.invalidateQueries({ queryKey: ["users"] }),
    queryClient.invalidateQueries({ queryKey: ["roles"] }),
  ]);
};
