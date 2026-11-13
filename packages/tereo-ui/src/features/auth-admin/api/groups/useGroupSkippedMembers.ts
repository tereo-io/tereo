import { useInfiniteQuery } from "@tanstack/react-query";
import type { GroupSkippedMembersPage } from "./types";
import { useAxios } from "@/lib/auth";

/** The users a pushed group's directory listed but core could not add. */
const useGroupSkippedMembers = (groupId: string, enabled: boolean) => {
  const axios = useAxios("auth");

  return useInfiniteQuery({
    queryKey: ["groups", groupId, "skipped-members"],
    enabled: !!groupId && enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<GroupSkippedMembersPage> => {
      const res = await axios.get(
        `/v1/admin/groups/${groupId}/scim/skipped-members`,
        { params: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } }
      );
      return res.data;
    },
    getNextPageParam: (last) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
  });
};

export default useGroupSkippedMembers;
