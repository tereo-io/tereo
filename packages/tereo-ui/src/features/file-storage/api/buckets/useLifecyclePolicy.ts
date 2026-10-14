import { useQuery } from "@tanstack/react-query";
import type { LifecyclePolicy } from "./types";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useLifecyclePolicy = (bucketName: string | undefined) => {
  const axios = useAxios("fileService");
  return useQuery<LifecyclePolicy | null>({
    queryKey: ["lifecycle-policy", bucketName],
    enabled: !!bucketName,
    queryFn: async () => {
      try {
        const response = await axios.get<LifecyclePolicy>(
          `/buckets/${bucketName}/lifecycle`
        );
        return response.data;
      } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) {
          return null;
        }
        throw error;
      }
    },
  });
};

export default useLifecyclePolicy;
