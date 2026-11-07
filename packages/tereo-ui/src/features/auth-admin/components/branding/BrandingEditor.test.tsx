import { RouterProvider, createMemoryRouter, Link } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { BrandingProfile } from "../../api/branding/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveBranding } from "@/features/auth";
import userEvent from "@testing-library/user-event";
import { BrandingEditor } from "./BrandingEditor";
import { authMock } from "@/test/authMock";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const own = {
  appName: "Acme",
  headline: null,
  subtitle: null,
  signInLabel: null,
  notice: null,
  layout: null,
  footerLinks: null,
  colorsLight: {},
  colorsDark: {},
  applyToConsole: false,
  logo: null,
  logoDark: null,
  favicon: null,
  background: null,
};

const effective: EffectiveBranding = {
  scope: "auth",
  appName: null,
  headline: null,
  subtitle: null,
  signInLabel: null,
  notice: null,
  layout: null,
  footerLinks: null,
  colorsLight: {},
  colorsDark: {},
  logoUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  backgroundUrl: null,
  applyToConsole: false,
};

const profile = (over: Partial<BrandingProfile> = {}): BrandingProfile => ({
  client: { id: "c1", clientId: "web-app", name: "Web App" },
  own,
  effective: { ...effective, appName: "Acme" },
  inherited: null,
  sources: { appName: "client" },
  colorSources: { light: {}, dark: {} },
  provisioned: false,
  provisionedFrom: null,
  updatedAt: "2026-11-01T00:00:00Z",
  canEdit: true,
  canManageGrants: true,
  ...over,
});

const renderEditor = (data: BrandingProfile) => {
  authMock.axios.get.mockResolvedValue({ data });
  const router = createMemoryRouter(
    [
      {
        path: "/edit",
        element: (
          <>
            <BrandingEditor target={{ kind: "client", id: "c1" }} />
            <Link to="/other">Leave</Link>
          </>
        ),
      },
      { path: "/other", element: <p>Other page</p> },
      { path: "/auth-admin/branding", element: <p>Branding list</p> },
    ],
    { initialEntries: ["/edit"] }
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
};

beforeEach(() => {
  authMock.permissions = ["branding.read", "branding.write"];
  authMock.axios.get.mockReset();
  authMock.axios.put.mockReset();
  authMock.axios.delete.mockReset();
  authMock.axios.put.mockResolvedValue({ data: {} });
  authMock.axios.post.mockReset();
});

describe("BrandingEditor", () => {
  it("renders a provisioned profile read-only and explains on Edit", async () => {
    const user = userEvent.setup();
    renderEditor(
      profile({
        provisioned: true,
        provisionedFrom: "web-app.json",
        canEdit: false,
      })
    );
    expect(await screen.findByLabelText("App name")).toHaveAttribute(
      "readonly"
    );
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByText(/This branding is set in/);
    expect(dialog.parentElement?.textContent).toContain("web-app.json");
    expect(dialog.parentElement?.textContent).toContain(
      "npm run cli -- provision"
    );
    expect(dialog.parentElement?.textContent).toContain(
      "Removing it from the document makes it editable here."
    );
  });

  it("reads inputs as read-only when canEdit is false", async () => {
    renderEditor(profile({ canEdit: false }));
    expect(await screen.findByLabelText("App name")).toHaveAttribute(
      "readonly"
    );
  });

  it("shows the server message on the image field when an upload is rejected", async () => {
    const user = userEvent.setup();
    authMock.axios.post.mockRejectedValue({
      response: { data: { error_description: "File too large" } },
    });
    renderEditor(profile());
    const input = await screen.findByLabelText("Logo");
    await user.upload(
      input,
      new File(["x"], "logo.png", { type: "image/png" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File too large"
    );
  });

  it("saves the full body with PUT and Discard restores the loaded values", async () => {
    const user = userEvent.setup();
    renderEditor(profile());
    const name = await screen.findByLabelText("App name");
    await user.clear(name);
    await user.type(name, "Beta");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("App name")).toHaveValue("Acme");

    await user.type(screen.getByLabelText("Headline"), "Hi");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(authMock.axios.put).toHaveBeenCalled());
    const [url, body] = authMock.axios.put.mock.calls[0];
    expect(url).toBe("/v1/admin/branding/clients/c1");
    expect(body).toEqual({
      ...own,
      headline: "Hi",
      logo: null,
      logoDark: null,
      favicon: null,
      background: null,
    });
  });

  it("previews the inherited app name once the override is cleared", async () => {
    const user = userEvent.setup();
    renderEditor(
      profile({
        own: { ...own, appName: "Foo" },
        effective: { ...effective, appName: "Foo" },
        inherited: { ...effective, appName: "Acme" },
      })
    );
    const preview = await screen.findByTestId("branding-preview");
    expect(
      within(preview).getByRole("heading", { name: "Foo" })
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText("App name"));
    expect(
      within(preview).getByRole("heading", { name: "Acme" })
    ).toBeInTheDocument();
  });

  it("previews the inherited colour once the override is cleared", async () => {
    const user = userEvent.setup();
    renderEditor(
      profile({
        own: { ...own, colorsLight: { "--k-primary-color": "#ff0000" } },
        effective: {
          ...effective,
          colorsLight: { "--k-primary-color": "#ff0000" },
        },
        inherited: {
          ...effective,
          colorsLight: { "--k-primary-color": "#0000ff" },
        },
      })
    );
    const frame = await screen.findByTestId("branding-preview-frame");
    expect(frame.getAttribute("style")).toContain("#ff0000");
    await user.clear(screen.getByLabelText("primary-color"));
    expect(frame.getAttribute("style")).toContain("#0000ff");
  });

  it("uses the inherited value as the placeholder when the profile overrides", async () => {
    renderEditor(
      profile({
        own: {
          ...own,
          appName: "Foo",
          colorsLight: { "--k-primary-color": "#ff0000" },
        },
        inherited: {
          ...effective,
          appName: "Acme",
          colorsLight: { "--k-primary-color": "#111111" },
        },
        sources: { appName: "client" },
        colorSources: { light: { "--k-primary-color": "client" }, dark: {} },
      })
    );
    expect(await screen.findByLabelText("primary-color")).toHaveAttribute(
      "placeholder",
      "#111111 (from Default)"
    );
    expect(screen.getByLabelText("App name")).toHaveAttribute(
      "placeholder",
      "Acme"
    );
  });

  it("shows the grants panel only when the viewer can manage grants", async () => {
    renderEditor(profile({ canManageGrants: false }));
    await screen.findByTestId("branding-preview");
    expect(screen.queryByText("Who can edit")).toBeNull();
  });

  it("prompts before leaving with unsaved changes", async () => {
    const user = userEvent.setup();
    renderEditor(profile());
    await user.type(await screen.findByLabelText("Headline"), "Hi");
    await user.click(screen.getByText("Leave"));
    expect(await screen.findByText("Discard unsaved changes?")).toBeVisible();
    expect(screen.queryByText("Other page")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByText("Other page")).toBeVisible();
  });

  it("leaves freely when nothing changed", async () => {
    const user = userEvent.setup();
    renderEditor(profile());
    await screen.findByLabelText("Headline");
    await user.click(screen.getByText("Leave"));
    expect(await screen.findByText("Other page")).toBeVisible();
  });

  it("ignores clicks on the console checkbox when the profile is locked", async () => {
    const user = userEvent.setup();
    renderEditor(
      profile({
        client: { id: "c1", clientId: "tereo-ui", name: "Console" },
        provisioned: true,
        provisionedFrom: "core.json",
        canEdit: false,
      })
    );
    const box = await screen.findByLabelText("Also brand the admin console");
    await user.click(box);
    expect(box).not.toBeChecked();
    await user.click(screen.getByText("Leave"));
    expect(await screen.findByText("Other page")).toBeVisible();
  });

  it("navigates to the list after a successful delete, even as the refetch remounts the form", async () => {
    const user = userEvent.setup();
    renderEditor(profile());
    await screen.findByLabelText("App name");
    authMock.axios.delete.mockResolvedValue({});
    authMock.axios.get.mockResolvedValue({
      data: profile({ own: null, updatedAt: null }),
    });
    await user.click(screen.getByRole("button", { name: "Remove branding" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Branding list")).toBeVisible();
  });
});
