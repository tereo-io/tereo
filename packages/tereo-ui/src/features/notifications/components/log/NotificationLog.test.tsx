import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { NotificationLog } from "./NotificationLog";
import userEvent from "@testing-library/user-event";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const entry = (over: Record<string, unknown>) => ({
  id: "n1",
  channel: "email",
  connectionId: null,
  senderUserId: "11111111-1111-4111-8111-111111111111",
  organizationId: null,
  status: "sent",
  summary: "Invoice 1042",
  recipients: [{ address: "a@example.com", as: "to" }],
  attachments: [],
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:01:00.000Z",
  sentAt: "2026-10-01T10:00:30.000Z",
  ...over,
});

const urls = () =>
  authMock.axios.get.mock.calls.map((c) => decodeURIComponent(c[0] as string));

describe("NotificationLog", () => {
  beforeEach(() => {
    authMock.permissions = ["notifications.read"];
    authMock.axios.get.mockReset();
    authMock.axios.get.mockImplementation(async (url: string) => {
      if (url.includes("cursor=c2"))
        return {
          data: {
            data: [
              entry({ id: "n3", recipients: [{ address: "z@example.com" }] }),
            ],
            hasMore: false,
            limit: 25,
            nextCursor: null,
          },
        };
      return {
        data: {
          data: [
            entry({}),
            entry({
              id: "n2",
              status: "failed",
              summary: "Overdue reminder",
              sentAt: null,
              recipients: [
                { address: "b@example.com", as: "to" },
                { address: "c@example.com", as: "cc" },
              ],
            }),
          ],
          hasMore: true,
          limit: 25,
          nextCursor: "c2",
        },
      };
    });
  });

  it("renders a row per notification with a status badge and recipients", async () => {
    renderWithProviders(<NotificationLog />);
    expect(await screen.findByText("a@example.com")).toBeInTheDocument();
    expect(
      screen.getByText("b@example.com, c@example.com")
    ).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("failed")).toBeInTheDocument();
    expect(table.getByText("sent")).toBeInTheDocument();
    expect(urls()[0]).toContain("/v1/admin/notifications?");
  });

  it("shows each send's subject and when it was sent, in place of Updated", async () => {
    renderWithProviders(<NotificationLog />);
    await screen.findByText("a@example.com");
    const table = within(screen.getByRole("table"));
    expect(table.getByRole("columnheader", { name: "Subject" })).toBeVisible();
    expect(table.getByRole("columnheader", { name: "Sent" })).toBeVisible();
    expect(
      table.queryByRole("columnheader", { name: "Updated" })
    ).not.toBeInTheDocument();
    expect(table.getByText("Invoice 1042")).toBeInTheDocument();
    expect(table.getByText("Overdue reminder")).toBeInTheDocument();
    const failedRow = table.getByText("Overdue reminder").closest("tr")!;
    expect(within(failedRow).getByText("—")).toBeInTheDocument();
  });

  it("puts a changed filter in the query", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationLog />);
    await screen.findByText("a@example.com");

    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    await waitFor(() =>
      expect(urls().some((u) => u.includes("filter[status]=failed"))).toBe(true)
    );

    await user.type(screen.getByLabelText("Recipient"), "B@Example.com{Enter}");
    await waitFor(() =>
      expect(
        urls().some((u) => u.includes("filter[recipient]=B@Example.com"))
      ).toBe(true)
    );
  });

  it("flags a sender that is not a user ID and keeps the previous filter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationLog />);
    await screen.findByText("a@example.com");
    const sender = screen.getByLabelText("Sender (user ID)");
    const valid = "22222222-2222-4222-8222-222222222222";

    await user.type(sender, `${valid}{Enter}`);
    await waitFor(() =>
      expect(
        urls().some((u) => u.includes(`filter[senderUserId]=${valid}`))
      ).toBe(true)
    );

    await user.clear(sender);
    await user.type(sender, "not-a-uuid{Enter}");
    expect(
      await screen.findByText("Enter a user ID (UUID)")
    ).toBeInTheDocument();
    expect(urls().at(-1)).toContain(`filter[senderUserId]=${valid}`);

    await user.clear(sender);
    await user.type(sender, "{Enter}");
    await waitFor(() =>
      expect(urls().at(-1)).not.toContain("filter[senderUserId]")
    );
    expect(
      screen.queryByText("Enter a user ID (UUID)")
    ).not.toBeInTheDocument();
  });

  it("loads the next page with the cursor", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationLog />);
    await screen.findByText("a@example.com");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("z@example.com")).toBeInTheDocument();
    expect(urls().some((u) => u.includes("cursor=c2"))).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Load more" })
    ).not.toBeInTheDocument();
  });
});
