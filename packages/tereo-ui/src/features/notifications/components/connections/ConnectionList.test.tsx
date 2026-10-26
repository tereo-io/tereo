import type { NotificationConnection } from "../../api/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { ConnectionList } from "./ConnectionList";
import { screen } from "@testing-library/react";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const connection = (over: Partial<NotificationConnection>) =>
  ({
    id: "c1",
    channel: "email",
    slug: "main",
    displayName: "Main SMTP",
    isDefault: true,
    isEnabled: true,
    settings: { host: "smtp.example.com", port: 587 },
    hasSecrets: true,
    maxPerMinute: null,
    ...over,
  }) as NotificationConnection;

describe("ConnectionList", () => {
  beforeEach(() => {
    authMock.axios.get.mockReset();
    authMock.axios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/channels"))
        return {
          data: {
            data: [{ channel: "email", settingsSchema: {}, secretsSchema: {} }],
          },
        };
      return {
        data: {
          data: [
            connection({}),
            connection({
              id: "c2",
              slug: "bulk",
              displayName: "Bulk",
              isDefault: false,
              isEnabled: false,
              lastDeliveryError: {
                message: "Connection closed unexpectedly",
                at: "2026-10-22T19:00:00Z",
              },
            }),
          ],
        },
      };
    });
  });

  it("lists connections with their default and disabled state", async () => {
    authMock.permissions = ["notifications.read"];
    renderWithProviders(<ConnectionList />);
    expect(await screen.findByText("Main SMTP")).toBeInTheDocument();
    expect(screen.getByText("Bulk")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(authMock.axios.get).toHaveBeenCalledWith(
      "/v1/admin/notifications/connections"
    );
  });

  it("shows a connection's latest delivery error", async () => {
    authMock.permissions = ["notifications.read"];
    renderWithProviders(<ConnectionList />);

    expect(
      await screen.findByText(
        /Last send failed .*Connection closed unexpectedly/
      )
    ).toBeVisible();
  });

  it("hides the admin controls without notifications.admin", async () => {
    authMock.permissions = ["notifications.read"];
    renderWithProviders(<ConnectionList />);
    await screen.findByText("Main SMTP");
    expect(screen.queryByRole("button", { name: /New connection/ })).toBeNull();
    expect(screen.queryByTitle("Edit")).toBeNull();
    expect(screen.queryByTitle("Send test")).toBeNull();
    expect(screen.queryByTitle("Delete")).toBeNull();
  });

  it("offers create, edit, test, default and delete to an admin", async () => {
    authMock.permissions = ["notifications.read", "notifications.admin"];
    renderWithProviders(<ConnectionList />);
    await screen.findByText("Main SMTP");
    expect(
      screen.getByRole("button", { name: /New connection/ })
    ).toBeInTheDocument();
    expect(screen.getAllByTitle("Edit")).toHaveLength(2);
    expect(screen.getAllByTitle("Send test")).toHaveLength(2);
    expect(screen.getAllByTitle("Delete")).toHaveLength(2);
    // Only the non-default connection can be made the default.
    expect(screen.getAllByTitle("Make default")).toHaveLength(1);
  });
});
