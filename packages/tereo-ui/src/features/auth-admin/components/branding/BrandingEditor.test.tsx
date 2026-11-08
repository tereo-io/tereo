import type { BrandingProfile, BrandingTarget } from "../../api/branding/types";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider, createMemoryRouter, Link } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveBranding } from "@/features/auth";
import userEvent from "@testing-library/user-event";
import { BrandingEditor } from "./BrandingEditor";
import { authMock } from "@/test/authMock";
import { AxiosError } from "axios";
import env from "@/lib/env";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";

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
  canViewGrants: true,
  ...over,
});

const mountEditor = (target: BrandingTarget) => {
  const router = createMemoryRouter(
    [
      {
        path: "/edit",
        element: (
          <>
            <BrandingEditor target={target} />
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

const renderEditor = (data: BrandingProfile) => {
  authMock.axios.get.mockResolvedValue({ data });
  mountEditor({ kind: "client", id: "c1" });
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

  it("hides the grants panel from a viewer who may not list grants", async () => {
    renderEditor(profile({ canManageGrants: false, canViewGrants: false }));
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

  it("loads an image field's thumbnail from core", async () => {
    renderEditor(
      profile({
        own: {
          ...own,
          logo: { sha256: "a", url: "/oauth/branding/assets/a.png" },
        },
      })
    );
    expect(await screen.findByAltText("Logo preview")).toHaveAttribute(
      "src",
      `${env.CORE_URL}/oauth/branding/assets/a.png`
    );
  });

  describe("the default profile's console toggle", () => {
    const renderDefault = (listedClients: { clientId: string }[]) => {
      authMock.permissions = ["branding.admin"];
      authMock.axios.get.mockImplementation(async (url: string) =>
        url === "/v1/admin/branding"
          ? {
              data: {
                default: null,
                clients: listedClients.map((c, i) => ({
                  id: `c${i}`,
                  name: c.clientId,
                  provisioned: false,
                  updatedAt: "2026-11-01T00:00:00Z",
                  ...c,
                })),
                brandable: [],
              },
            }
          : { data: profile({ client: null, canManageGrants: false }) }
      );
      mountEditor({ kind: "default" });
    };

    it("explains that it does nothing while tereo-ui has its own profile", async () => {
      renderDefault([{ clientId: "tereo-ui" }]);
      await screen.findByLabelText("Also brand the admin console");
      expect(
        await screen.findByText(/has its own branding profile/)
      ).toBeInTheDocument();
    });

    it("gives no hint when tereo-ui has no profile", async () => {
      renderDefault([{ clientId: "web-app" }]);
      await screen.findByLabelText("Also brand the admin console");
      await waitFor(() =>
        expect(authMock.axios.get).toHaveBeenCalledWith("/v1/admin/branding")
      );
      expect(
        screen.queryByText(/has its own branding profile/)
      ).not.toBeInTheDocument();
    });
  });

  const refocus = () =>
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

  describe("when the profile changes elsewhere", () => {
    it("keeps unsaved edits and offers a reload", async () => {
      const user = userEvent.setup();
      renderEditor(profile());
      await user.type(await screen.findByLabelText("Headline"), "Mine");
      authMock.axios.get.mockResolvedValue({
        data: profile({
          own: { ...own, appName: "Theirs" },
          updatedAt: "2026-11-02T00:00:00Z",
        }),
      });
      refocus();
      expect(
        await screen.findByText(/changed elsewhere since you opened it/)
      ).toBeVisible();
      expect(screen.getByLabelText("Headline")).toHaveValue("Mine");
      expect(screen.getByLabelText("App name")).toHaveValue("Acme");

      await user.click(
        screen.getByRole("button", { name: "Reload and discard my edits" })
      );
      expect(screen.getByLabelText("App name")).toHaveValue("Theirs");
      expect(screen.getByLabelText("Headline")).toHaveValue("");
      expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    });

    it("takes the new values when nothing is unsaved", async () => {
      renderEditor(profile());
      await screen.findByLabelText("App name");
      authMock.axios.get.mockResolvedValue({
        data: profile({
          own: { ...own, appName: "Theirs" },
          updatedAt: "2026-11-02T00:00:00Z",
        }),
      });
      refocus();
      await waitFor(() =>
        expect(screen.getByLabelText("App name")).toHaveValue("Theirs")
      );
      expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    });

    it("starts fresh after its own save, without the notice", async () => {
      const user = userEvent.setup();
      renderEditor(profile());
      await user.type(await screen.findByLabelText("Headline"), "Hi");
      authMock.axios.get.mockResolvedValue({
        data: profile({
          own: { ...own, headline: "Hi" },
          updatedAt: "2026-11-02T00:00:00Z",
        }),
      });
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
      );
      expect(screen.getByLabelText("Headline")).toHaveValue("Hi");
      expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    });
  });

  it("is not dirty after a colour is cleared and retyped", async () => {
    const user = userEvent.setup();
    renderEditor(
      profile({
        own: {
          ...own,
          colorsLight: {
            "--k-primary-color": "#112233",
            "--k-danger-color": "#aa0000",
          },
        },
      })
    );
    const primary = await screen.findByLabelText("primary-color");
    await user.clear(primary);
    await user.type(primary, "#112233");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows an error with a retry when loading fails, not 'not found'", async () => {
    const user = userEvent.setup();
    authMock.axios.get.mockRejectedValue(
      new AxiosError("boom", "ERR", undefined, undefined, {
        status: 500,
      } as never)
    );
    mountEditor({ kind: "client", id: "c1" });
    expect(
      await screen.findByText("Could not load this branding")
    ).toBeVisible();
    expect(screen.queryByText("Branding not found")).toBeNull();
    authMock.axios.get.mockResolvedValue({ data: profile() });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("App name")).toHaveValue("Acme");
  });

  it("says not found on a 404", async () => {
    authMock.axios.get.mockRejectedValue(
      new AxiosError("missing", "ERR", undefined, undefined, {
        status: 404,
      } as never)
    );
    mountEditor({ kind: "client", id: "c1" });
    expect(await screen.findByText("Branding not found")).toBeVisible();
  });

  describe("footer links", () => {
    const saved = async () => {
      await waitFor(() => expect(authMock.axios.put).toHaveBeenCalled());
      return authMock.axios.put.mock.calls[0][1];
    };

    it("saves No links as an empty list", async () => {
      const user = userEvent.setup();
      renderEditor(profile());
      await user.click(await screen.findByLabelText("No links"));
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect((await saved()).footerLinks).toEqual([]);
    });

    it("keeps a stored empty list and can go back to inheriting", async () => {
      const user = userEvent.setup();
      renderEditor(profile({ own: { ...own, footerLinks: [] } }));
      expect(await screen.findByLabelText("No links")).toBeChecked();
      await user.click(screen.getByLabelText("Inherit"));
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect((await saved()).footerLinks).toBeNull();
    });

    it("previews No links over inherited ones", async () => {
      const user = userEvent.setup();
      renderEditor(
        profile({
          inherited: {
            ...effective,
            footerLinks: [{ label: "Privacy", url: "https://acme.test/p" }],
          },
        })
      );
      const preview = await screen.findByTestId("branding-preview");
      expect(within(preview).getByText("Privacy")).toBeInTheDocument();
      await user.click(screen.getByLabelText("No links"));
      expect(within(preview).queryByText("Privacy")).toBeNull();
    });
  });

  it("lists grants read-only for a viewer who may not manage them", async () => {
    authMock.axios.get.mockImplementation(async (url: string) =>
      url.endsWith("/grants")
        ? {
            data: {
              data: [
                {
                  userId: "u1",
                  email: "ann@acme.test",
                  name: "Ann",
                  grantedBy: "u0",
                  grantedAt: "2026-11-01T00:00:00Z",
                },
              ],
            },
          }
        : { data: profile({ canManageGrants: false, canViewGrants: true }) }
    );
    mountEditor({ kind: "client", id: "c1" });
    expect(await screen.findByText("ann@acme.test")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Revoke ann@acme.test" })
    ).toBeNull();
  });
});
