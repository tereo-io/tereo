import { useQuery } from "@tanstack/react-query";
import encodeObjectKey from "./encodeObjectKey";
import useObjectUrl from "@/hooks/useObjectUrl";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

export type ThumbnailSize = "thumb" | "small" | "medium";

interface UseObjectThumbnailOptions {
  /** When false the query is skipped — used to defer off-screen thumbnail downloads. */
  enabled?: boolean;
}

/** The thumbnail as an object URL, revoked when the calling component unmounts. */
const useObjectThumbnail = (
  bucketName: string | undefined,
  objectKey: string | undefined,
  contentType: string | undefined,
  size: ThumbnailSize = "thumb",
  options?: UseObjectThumbnailOptions
) => {
  const axios = useAxios("fileService");
  const isImage = !!contentType && contentType.startsWith("image/");

  const query = useQuery<Blob | null>({
    queryKey: ["object-thumbnail", bucketName, objectKey, size],
    enabled:
      (options?.enabled ?? true) && !!bucketName && !!objectKey && isImage,
    // Generation is async on the server — a 404 means "not ready yet" and
    // should quietly fall back to the file icon rather than error-spamming.
    retry: false,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    queryFn: async () => {
      try {
        const res = await axios.get(
          `/buckets/${bucketName}/objects/${encodeObjectKey(objectKey ?? "")}`,
          { params: { thumbnail: size }, responseType: "blob" }
        );
        if (!res.data || res.data.size === 0) return null;
        return res.data as Blob;
      } catch (err) {
        if ((err as AxiosError).response?.status === 404) return null;
        throw err;
      }
    },
  });
  const url = useObjectUrl(query.data);
  return { data: url, isLoading: query.isLoading };
};

export default useObjectThumbnail;
