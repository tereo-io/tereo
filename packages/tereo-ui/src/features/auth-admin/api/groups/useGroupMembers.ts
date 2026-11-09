import { useInfiniteQuery } from "@tanstack/react-query";
import type { GroupMembersPage } from "./types";
import { useAxios } from "@/lib/auth";

const useGroupMembers = (groupId: string) => {
  const axios = useAxios("auth");

  return useInfiniteQuery({
    queryKey: ["groups", groupId, "members"],
    enabled: !!groupId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<GroupMembersPage> => {
      const res = await axios.get(`/v1/admin/groups/${groupId}/members`, {
        params: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
      });
      return res.data;
    },
    getNextPageParam: (last) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
  });
};

export default useGroupMembers;
