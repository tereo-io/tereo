import type { NotificationConnection } from "../../api/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestConnectionModal } from "./TestConnectionModal";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const connection = {
  id: "c1",
  displayName: "Main SMTP",
} as NotificationConnection;

const send = async (to: string) => {
  const user = userEvent.setup();
  renderWithProviders(
    <TestConnectionModal show connection={connection} onClose={() => {}} />
  );
  await user.type(screen.getByLabelText(/^Send to/), to);
  await user.click(screen.getByRole("button", { name: "Send test" }));
};

describe("TestConnectionModal", () => {
  beforeEach(() => {
    authMock.axios.post.mockReset();
  });

  it("shows the provider's refusal", async () => {
    authMock.axios.post.mockResolvedValue({
      data: { ok: false, error: "Connection refused by smtp.example.com" },
    });
    await send("me@example.com");
    expect(authMock.axios.post).toHaveBeenCalledWith(
      "/v1/admin/notifications/connections/c1/test",
      { to: "me@example.com" }
    );
    expect(
      await screen.findByText("Connection refused by smtp.example.com")
    ).toBeInTheDocument();
  });

  it("shows the provider's response on success", async () => {
    authMock.axios.post.mockResolvedValue({
      data: { ok: true, providerResponse: "250 2.0.0 queued as ABC" },
    });
    await send("me@example.com");
    expect(
      await screen.findByText(/250 2.0.0 queued as ABC/)
    ).toBeInTheDocument();
  });

  it("shows a request error such as an invalid address", async () => {
    authMock.axios.post.mockRejectedValue({
      response: { data: { error_description: "to must be an email address" } },
    });
    await send("me@blocked");
    expect(
      await screen.findByText("to must be an email address")
    ).toBeInTheDocument();
  });
});
