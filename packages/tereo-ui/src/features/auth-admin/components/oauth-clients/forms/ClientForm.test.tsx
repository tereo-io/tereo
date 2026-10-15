import type { OAuthClient } from "../../../api/oauth-clients/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_SERVICE_ID } from "@/features/services";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { authMock } from "@/test/authMock";
import { ClientForm } from "./ClientForm";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const services = [
  { id: CORE_SERVICE_ID, slug: "core", name: "Core", namespace: "core" },
  { id: "s1", slug: "billing", name: "Billing", namespace: "billing" },
  { id: "s2", slug: "crm", name: "CRM", namespace: "crm" },
];

const stored: OAuthClient = {
  id: "c1",
  clientId: "web-app",
  clientType: "confidential",
  name: "Web App",
  redirectUris: ["https://app.example.com/cb"],
  postLogoutRedirectUris: [],
  scopes: ["openid"],
  grantTypes: ["authorization_code", "refresh_token"],
  audience: [],
  consentRequired: true,
  ownerId: "u1",
  service: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

const renderForm = (client?: OAuthClient) => {
  const onSubmit = vi.fn();
  renderWithProviders(
    <>
      <ClientForm formId="f" client={client} onSubmit={onSubmit} />
      <button type="submit" form="f">
        Save
      </button>
    </>
  );
  return onSubmit;
};

beforeEach(() => {
  authMock.permissions = ["services.read", "services.approve"];
  authMock.axios.get.mockReset();
  authMock.axios.get.mockResolvedValue({
    data: { data: services, hasMore: false, nextCursor: null },
  });
});

describe("ClientForm audience and consent", () => {
  it("creates with consent required and an empty audience by default", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();

    expect(
      screen.getByLabelText("Ask users to approve this app")
    ).toBeChecked();
    await user.type(screen.getByLabelText(/^Name/), "New App");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      consentRequired: true,
      audience: [],
    });
  });

  it("submits the chosen audience and a cleared consent box", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();

    await user.type(screen.getByLabelText(/^Name/), "New App");
    await user.click(screen.getByLabelText("Ask users to approve this app"));
    await screen.findByText("Audience");
    await user.click(screen.getByText(/^Services this client/));
    expect(screen.queryByText("Core")).not.toBeInTheDocument();
    await user.click(await screen.findByText("Billing"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      consentRequired: false,
      audience: ["billing"],
    });
  });

  it("hides the audience control without services.approve", () => {
    authMock.permissions = ["services.read"];
    renderForm();

    expect(screen.queryByText("Audience")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Ask users to approve this app")
    ).toBeInTheDocument();
  });

  it("hides the audience control and sends none with approve but not read", async () => {
    authMock.permissions = ["services.approve"];
    const user = userEvent.setup();
    const onSubmit = renderForm();

    expect(screen.queryByText("Audience")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name/), "New App");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("audience");
  });

  it("sends no audience on edit with approve but not read", async () => {
    authMock.permissions = ["services.approve"];
    const user = userEvent.setup();
    const onSubmit = renderForm({ ...stored, audience: ["billing"] });

    await user.click(screen.getByLabelText("Ask users to approve this app"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit.mock.calls[0][0]).toEqual({ consentRequired: false });
  });

  it("sends only the consent change when editing", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm(stored);

    await user.click(screen.getByLabelText("Ask users to approve this app"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit.mock.calls[0][0]).toEqual({ consentRequired: false });
  });

  it("hides both controls for core's own login client", () => {
    renderForm({ ...stored, clientId: "tereo-ui" });

    expect(screen.queryByText("Audience")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Ask users to approve this app")
    ).not.toBeInTheDocument();
  });
});
