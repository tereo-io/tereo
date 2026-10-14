import { useQuery } from "@tanstack/react-query";
import { useAuth, useAxios } from "@/lib/auth";
import type { Bucket } from "./types";

const useBucket = (bucketName: string) => {
  const { hasPermission } = useAuth();
  const axios = useAxios("fileService");

  const queryFn = async (): Promise<Bucket> => {
    const res = await axios.get(`/buckets/${bucketName}`);
    return res.data;
  };

  return useQuery({
    queryKey: ["bucket", bucketName],
    queryFn,
    enabled: !!bucketName && hasPermission("file-service.buckets.read"),
  });
};

export default useBucket;
