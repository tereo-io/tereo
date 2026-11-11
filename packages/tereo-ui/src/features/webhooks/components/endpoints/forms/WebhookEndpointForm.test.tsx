import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookEndpointForm } from "./WebhookEndpointForm";
import type { WebhookEndpoint } from "../../../api/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));

const endpoint: WebhookEndpoint = {
  id: "w1",
  organizationId: "o1",
  url: "https://billing.example.com/hook",
  description: null,
  signingSecret: "whsec_ab...",
  status: "ACTIVE",
  customHeaders: { "X-Api-Key": "********" },
  consecutiveFailures: 0,
  archivedAt: null,
  previousSecretExpiresAt: null,
  hasDeliveries: false,
  provisioned: false,
  ownerService: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  createdBy: "u1",
  creator: { id: "u1", email: "a@example.com", name: null },
  eventTypes: ["files.created"],
  retiredEventTypes: [],
};

const onSubmit = vi.fn();

const renderForm = (data: WebhookEndpoint = endpoint) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WebhookEndpointForm formId="f" endpoint={data} onSubmit={onSubmit} />
      <button type="submit" form="f">
        Save
      </button>
    </QueryClientProvider>
  );
  return userEvent.setup();
};

const setUrl = async (user: ReturnType<typeof userEvent.setup>, to: string) => {
  const input = screen.getByLabelText(/^URL/);
  await user.clear(input);
  await user.type(input, to);
};

const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => {
  onSubmit.mockReset();
  authMock.axios.get.mockReset();
  authMock.axios.get.mockResolvedValue({ data: { data: [], hasMore: false } });
});

describe("WebhookEndpointForm", () => {
  describe("a URL moved to another origin with saved header values", () => {
    it("refuses to save until the values are entered again", async () => {
      const user = renderForm();
      await setUrl(user, "https://other.example.net/hook");

      expect(
        screen.getByText(/saved header values are not sent to the new one/i)
      ).toBeVisible();

      await save(user);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(
        screen.getByText(/Enter the value of "X-Api-Key" again/)
      ).toBeVisible();
    });

    it("sends the re-entered values with the new URL", async () => {
      const user = renderForm();
      await setUrl(user, "https://other.example.net/hook");
      const value = screen.getByLabelText(/^Value/);
      await user.clear(value);
      await user.type(value, "fresh-key");
      await save(user);

      expect(onSubmit).toHaveBeenCalledWith({
        url: "https://other.example.net/hook",
        customHeaders: { "X-Api-Key": "fresh-key" },
      });
    });

    it("clears the headers when they are removed", async () => {
      const user = renderForm();
      await setUrl(user, "https://other.example.net/hook");
      await user.click(screen.getByRole("button", { name: "Remove header" }));
      await save(user);

      expect(onSubmit).toHaveBeenCalledWith({
        url: "https://other.example.net/hook",
        customHeaders: null,
      });
    });
  });

  it("keeps saved header values when the URL stays on its origin", async () => {
    const user = renderForm();
    await setUrl(user, "https://billing.example.com/v2/hook");

    expect(
      screen.queryByText(/saved header values are not sent to the new one/i)
    ).not.toBeInTheDocument();
    await save(user);
    expect(onSubmit).toHaveBeenCalledWith({
      url: "https://billing.example.com/v2/hook",
    });
  });

  it("asks for nothing when the endpoint has no saved headers", async () => {
    const user = renderForm({ ...endpoint, customHeaders: null });
    await setUrl(user, "https://other.example.net/hook");
    await save(user);

    expect(onSubmit).toHaveBeenCalledWith({
      url: "https://other.example.net/hook",
    });
  });
});
