import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import { useAxios } from "@/lib/auth";
import { AxiosError } from "axios";

interface UploadPhotoResponse {
  photoUrl: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

const useUploadPhoto = () => {
  const axios = useAxios("auth");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File): Promise<UploadPhotoResponse> => {
      const formData = new FormData();
      formData.append("file", file);

      const res = await axios.post("/v1/account/photo", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    },
    onSuccess: () => {
      toast.success("Profile photo updated");
      queryClient.invalidateQueries({ queryKey: ["account", "profile"] });
    },
    onError: (error: AxiosError<{ error_description?: string }>) => {
      toast.error(
        error.response?.data?.error_description || "Failed to upload photo"
      );
    },
  });
};

export default useUploadPhoto;
