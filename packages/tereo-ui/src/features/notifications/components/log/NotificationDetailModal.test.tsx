import { NotificationDetailModal } from "./NotificationDetailModal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const delivery = (over: Record<string, unknown>) => ({
  id: "d1",
  connectionId: "c1",
  recipients: [{ address: "a@example.com" }],
  status: "failed",
  attempts: 8,
  lastError: "550 mailbox unavailable",
  providerMessageId: null,
  providerResponse: "550 5.1.1 no such user",
  sentAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:05:00.000Z",
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  channel: "email",
  connectionId: "c1",
  senderUserId: "11111111-1111-4111-8111-111111111111",
  organizationId: null,
  status: "failed",
  recipients: [{ address: "a@example.com", as: "to" }],
  attachments: [
    {
      bucket: "docs",
      objectId: "o1",
      versionId: "v1",
      filename: "invoice.pdf",
      contentType: "application/pdf",
      size: 2048,
    },
  ],
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:05:00.000Z",
  content: { subject: "Your invoice", text: "Hello there" },
  deliveries: [delivery({})],
  ...over,
});

const open = (data: unknown) => {
  authMock.axios.get.mockResolvedValue({ data });
  return renderWithProviders(
    <NotificationDetailModal notificationId="n1" onClose={() => {}} />
  );
};

describe("NotificationDetailModal", () => {
  beforeEach(() => {
    authMock.permissions = ["notifications.read"];
    authMock.axios.get.mockReset();
    authMock.axios.post.mockReset();
  });

  it("shows content, attachments and each delivery's error and provider response", async () => {
    open(detail());
    expect(await screen.findByText("Your invoice")).toBeInTheDocument();
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.getByText(/invoice\.pdf/)).toBeInTheDocument();
    expect(screen.getByText("550 mailbox unavailable")).toBeInTheDocument();
    expect(screen.getByText("550 5.1.1 no such user")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(authMock.axios.get).toHaveBeenCalledWith(
      "/v1/admin/notifications/n1"
    );
  });

  it("says the content was removed once it is null", async () => {
    open(
      detail({
        content: null,
        status: "sent",
        deliveries: [
          delivery({
            status: "sent",
            lastError: null,
            sentAt: "2026-10-01T10:01:00.000Z",
          }),
        ],
      })
    );
    expect(
      await screen.findByText("Content removed after sending")
    ).toBeInTheDocument();
  });

  it("hides Retry without notifications.admin", async () => {
    open(detail());
    await screen.findByText("Your invoice");
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  it("hides Retry when no delivery failed", async () => {
    authMock.permissions = ["notifications.read", "notifications.admin"];
    open(
      detail({ status: "sent", deliveries: [delivery({ status: "sent" })] })
    );
    await screen.findByText("Your invoice");
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  it("retries through the endpoint with notifications.admin", async () => {
    authMock.permissions = ["notifications.read", "notifications.admin"];
    authMock.axios.post.mockResolvedValue({ data: { requeued: 1 } });
    const user = userEvent.setup();
    open(detail());
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(authMock.axios.post).toHaveBeenCalledWith(
        "/v1/admin/notifications/n1/retry"
      )
    );
  });

  it("copes with nothing_to_retry", async () => {
    authMock.permissions = ["notifications.read", "notifications.admin"];
    authMock.axios.post.mockRejectedValue({
      response: {
        status: 409,
        data: { error: "nothing_to_retry", error_description: "none failed" },
      },
    });
    const user = userEvent.setup();
    open(detail());
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(authMock.axios.post).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Retry" })).toBeEnabled();
  });
});
