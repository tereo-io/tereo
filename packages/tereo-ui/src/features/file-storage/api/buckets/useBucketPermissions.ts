import { useQuery } from "@tanstack/react-query";
import type { BucketPermissions } from "./types";
import { useAxios } from "@/lib/auth";

const useBucketPermissions = (bucketName: string | undefined) => {
  const axios = useAxios("fileService");

  const queryFn = async (): Promise<BucketPermissions> => {
    const res = await axios.get(`/buckets/${bucketName}/my-permissions`);
    return res.data;
  };

  return useQuery({
    queryKey: ["bucket-permissions", bucketName],
    queryFn,
    enabled: !!bucketName,
  });
};

export default useBucketPermissions;
