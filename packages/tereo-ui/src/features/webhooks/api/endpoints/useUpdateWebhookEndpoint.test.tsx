import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import useUpdateWebhookEndpoint from "./useUpdateWebhookEndpoint";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { authMock } from "@/test/authMock";
import type { ReactNode } from "react";
import { AxiosError } from "axios";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("react-toastify", () => ({
  toast: { error: toastError, success: vi.fn() },
}));
vi.mock("../useWebhooksAxios", () => ({ default: () => authMock.axios }));

const coreError = (status: number, data: object) =>
  new AxiosError("Request failed", undefined, undefined, undefined, {
    status,
    data,
  } as never);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

const update = async (error: AxiosError) => {
  authMock.axios.patch.mockRejectedValue(error);
  const { result } = renderHook(() => useUpdateWebhookEndpoint(), { wrapper });
  result.current.mutate({ id: "w1", updateData: { url: "https://b.test/" } });
  await waitFor(() => expect(result.current.isError).toBe(true));
};

beforeEach(() => {
  toastError.mockReset();
  authMock.axios.patch.mockReset();
});

describe("useUpdateWebhookEndpoint", () => {
  it("explains a refused origin change in the form's terms", async () => {
    await update(
      coreError(400, {
        error: "masked_header_value",
        error_description:
          "The URL's origin changes, so stored header values are not kept (X-Api-Key): send each header's real value, or customHeaders: null to send none.",
      })
    );

    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/Enter each header's value again, or remove/)
    );
    expect(toastError.mock.calls[0][0]).not.toContain("customHeaders");
  });

  it("shows core's description for any other error", async () => {
    await update(
      coreError(409, { error: "conflict", error_description: "Archived" })
    );

    expect(toastError).toHaveBeenCalledWith("Archived");
  });
});
