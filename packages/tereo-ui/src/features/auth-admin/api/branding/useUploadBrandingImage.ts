import type { BrandingImage, BrandingImageSlot } from "./types";
import { useMutation } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

/** Errors are left to the caller: they show on the field, not in a toast. */
const useUploadBrandingImage = () => {
  const axios = useAxios("auth");

  const mutationFn = async (data: {
    slot: BrandingImageSlot;
    file: File;
  }): Promise<BrandingImage> => {
    const form = new FormData();
    // Fields before the file, so the server sees the slot first.
    form.append("slot", data.slot);
    form.append("file", data.file);
    const res = await axios.post("/v1/admin/branding/assets", form);
    return { sha256: res.data.sha256, url: res.data.url };
  };

  return useMutation({ mutationFn });
};

export default useUploadBrandingImage;
