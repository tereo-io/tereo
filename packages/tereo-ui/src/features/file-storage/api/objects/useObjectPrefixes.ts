import { useQuery } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

export interface PrefixEntry {
  type: "prefix";
  prefix: string;
  objectCount: number;
  totalSizeBytes: string;
}

export interface PrefixObject {
  type: "object";
  /** Stable UUID — drives all id-addressed mutations. */
  id: string;
  key: string;
  contentType: string;
  sizeBytes: string;
  etag: string;
  tags: string[];
  updatedAt: string;
}

export type PrefixListEntry = PrefixEntry | PrefixObject;

export interface ListPrefixesResponse {
  data: PrefixListEntry[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

// Cache key convention: ["object-prefixes", bucketName, prefix].
// Separate cache entries per prefix let the tree view keep each folder
// cached as users navigate; invalidations from mutations broadcast to the
// whole bucket via queryClient.invalidateQueries({ queryKey: ["object-prefixes", bucketName] }),
// matching every prefix under that bucket.
const useObjectPrefixes = (
  bucketName: string | undefined,
  prefix: string,
  enabled: boolean = true
) => {
  const axios = useAxios("fileService");
  return useQuery<ListPrefixesResponse>({
    queryKey: ["object-prefixes", bucketName, prefix],
    enabled: !!bucketName && enabled,
    queryFn: async () => {
      const response = await axios.get<ListPrefixesResponse>(
        `/buckets/${bucketName}/objects/prefixes`,
        { params: { prefix, delimiter: "/" } }
      );
      return response.data;
    },
  });
};

export default useObjectPrefixes;
