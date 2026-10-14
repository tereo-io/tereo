import type { CompleteSetupInput, CompleteSetupResult } from "./types";
import { useMutation } from "@tanstack/react-query";
import { usePublicAxios } from "@/lib/auth";

/** Errors are shown inline by the page, not as toasts. */
const useCompleteSetup = () => {
  const axios = usePublicAxios("auth");

  return useMutation({
    mutationFn: async (
      input: CompleteSetupInput
    ): Promise<CompleteSetupResult> => {
      const res = await axios.post("/v1/setup", input);
      return res.data;
    },
  });
};

export default useCompleteSetup;
