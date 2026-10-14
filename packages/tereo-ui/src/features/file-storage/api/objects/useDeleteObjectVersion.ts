import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

const useDeleteObjectVersion = (bucketName: string, id: string) => {
  const axios = useAxios("fileService");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (versionId: string) => {
      await axios.delete(
        `/buckets/${bucketName}/objects/by-id/${id}/versions/${versionId}`
      );
    },
    onSuccess: () => {
      toast.success("Version deleted");
      queryClient.invalidateQueries({
        queryKey: ["object-versions", bucketName, id],
      });
      queryClient.invalidateQueries({
        queryKey: [`objects-${bucketName}-infinite`],
      });
      queryClient.invalidateQueries({
        queryKey: ["object-prefixes", bucketName],
      });
      queryClient.invalidateQueries({ queryKey: ["bucket", bucketName] });
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to delete version"
      );
    },
  });
};

export default useDeleteObjectVersion;
