import type { TestConnectionResult } from "../types";
import { useMutation } from "@tanstack/react-query";
import { useAxios } from "@/lib/auth";

/**
 * `POST /v1/admin/notifications/connections/:id/test` — a provider refusal is
 * a 200 with `ok: false`; an invalid `to` is a 400. The dialog shows both, so
 * nothing is toasted here.
 */
const useTestConnection = () => {
  const axios = useAxios("auth");

  const mutationFn = async ({
    id,
    to,
  }: {
    id: string;
    to: string;
  }): Promise<TestConnectionResult> => {
    const res = await axios.post(
      `/v1/admin/notifications/connections/${id}/test`,
      { to }
    );
    return res.data;
  };

  return useMutation({ mutationFn });
};

export default useTestConnection;
