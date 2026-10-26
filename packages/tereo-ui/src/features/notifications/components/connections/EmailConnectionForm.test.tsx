import type { NotificationConnection } from "../../api/types";
import { EmailConnectionForm } from "./EmailConnectionForm";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

const stored: NotificationConnection = {
  id: "c1",
  channel: "email",
  slug: "main",
  displayName: "Main SMTP",
  isDefault: true,
  isEnabled: true,
  settings: {
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    username: "mailer",
    defaultFrom: { address: "no-reply@example.com", name: "Example" },
    allowedSenders: ["no-reply@example.com"],
  },
  hasSecrets: true,
  maxPerMinute: 30,
  createdBy: "u",
  updatedBy: "u",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const renderForm = (
  props: Partial<React.ComponentProps<typeof EmailConnectionForm>> = {}
) => {
  const onSubmit = vi.fn();
  renderWithProviders(
    <>
      <EmailConnectionForm formId="f" onSubmit={onSubmit} {...props} />
      <button type="submit" form="f">
        Save
      </button>
    </>
  );
  return onSubmit;
};

describe("EmailConnectionForm", () => {
  it("submits settings without secrets when the password is untouched", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm({ connection: stored });

    expect(screen.getByLabelText(/^Password/)).toHaveAttribute(
      "placeholder",
      "Unchanged"
    );
    await user.clear(screen.getByLabelText(/^From name/));
    await user.type(screen.getByLabelText(/^From name/), "Example Co");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0][0];
    expect(values).not.toHaveProperty("secrets");
    expect(values.settings).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "mailer",
      defaultFrom: { address: "no-reply@example.com", name: "Example Co" },
      allowedSenders: ["no-reply@example.com"],
    });
    expect(values.maxPerMinute).toBe(30);
  });

  it("asks for the password again when the host changes", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm({ connection: stored });
    await user.clear(screen.getByLabelText(/^Host/));
    await user.type(screen.getByLabelText(/^Host/), "smtp2.example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the password again/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Password/), "s3cret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0][0];
    expect(values.settings.host).toBe("smtp2.example.com");
    expect(values.secrets).toEqual({ password: "s3cret" });
  });

  it("sends the password once it is typed", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm({ connection: stored });
    await user.type(screen.getByLabelText(/^Password/), "s3cret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit.mock.calls[0][0].secrets).toEqual({ password: "s3cret" });
  });

  it("sends secrets: null when the stored password is removed", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm({ connection: stored });
    await user.click(screen.getByLabelText(/Remove the stored password/));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit.mock.calls[0][0].secrets).toBeNull();
  });

  it("builds a new connection with a tag list of allowed senders", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    await user.type(screen.getByLabelText(/^Name/), "Marketing");
    await user.type(screen.getByLabelText(/^Slug/), "marketing");
    await user.type(screen.getByLabelText(/^Host/), "smtp.example.com");
    await user.type(screen.getByLabelText(/^From address/), "news@example.com");
    await user.type(
      screen.getByLabelText(/^Allowed senders/),
      "news@example.com{Enter}"
    );
    await user.type(screen.getByLabelText(/^Allowed senders/), "@example.org");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const values = onSubmit.mock.calls[0][0];
    expect(values.slug).toBe("marketing");
    expect(values.settings.allowedSenders).toEqual([
      "news@example.com",
      "@example.org",
    ]);
    expect(values.settings.username).toBeUndefined();
    expect(values).not.toHaveProperty("secrets");
    expect(values.maxPerMinute).toBeNull();
  });

  describe("port and security", () => {
    const security = () => screen.getByRole("combobox", { name: "Security" });

    it.each([
      ["465", "tls"],
      ["587", "starttls"],
    ])("follows port %s with %s", async (port, expected) => {
      const user = userEvent.setup();
      renderForm();

      await user.clear(screen.getByLabelText(/^Port/));
      await user.type(screen.getByLabelText(/^Port/), port);

      expect(security()).toHaveValue(expected);
    });

    it("stops following the port once security is picked", async () => {
      const user = userEvent.setup();
      renderForm();
      await user.selectOptions(security(), "starttls");

      await user.clear(screen.getByLabelText(/^Port/));
      await user.type(screen.getByLabelText(/^Port/), "465");

      expect(security()).toHaveValue("starttls");
    });

    it("warns about 465 with STARTTLS and refuses to save", async () => {
      const user = userEvent.setup();
      const onSubmit = renderForm({
        connection: {
          ...stored,
          settings: { ...stored.settings, port: 465, security: "starttls" },
        },
      });

      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByText(/Port 465 expects TLS/)).toBeVisible();
    });
  });

  it("shows the server's field issues under the fields", () => {
    renderForm({
      connection: stored,
      issues: [
        { path: "host", message: "Too short" },
        { path: "defaultFrom.address", message: "Invalid email address" },
      ],
    });
    expect(screen.getByText("Too short")).toBeInTheDocument();
    expect(screen.getByText("Invalid email address")).toBeInTheDocument();
  });
});
