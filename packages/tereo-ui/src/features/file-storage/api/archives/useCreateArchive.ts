import type { CreateArchiveInput, CreateArchiveResponse } from "./types";
import { useMutation } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

/**
 * Create an archive request with core and return the presigned
 * URL. The caller is responsible for actually triggering the download — we
 * intentionally don't do it inside the hook so callers can choose between
 * anchor-click (native browser download UX) and window.open (new tab) as
 * suits their surface.
 */
const useCreateArchive = (bucketName: string) => {
  const axios = useAxios("fileService");

  return useMutation<CreateArchiveResponse, AxiosError, CreateArchiveInput>({
    mutationFn: async (input) => {
      const res = await axios.post<CreateArchiveResponse>(
        `/buckets/${bucketName}/archives`,
        input
      );
      return res.data;
    },
    onError: (error) => {
      const data = error.response?.data as
        { error_description?: string } | undefined;
      toast.error(data?.error_description || "Failed to create archive");
    },
  });
};

export default useCreateArchive;
