import type { Role } from "@/features/auth-admin/api/roles/types";
import { RoleForm, roleFormErrors } from "./RoleForm";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { AxiosError } from "axios";

const renderForm = (props: Partial<Parameters<typeof RoleForm>[0]> = {}) => {
  const onSubmit = vi.fn();
  renderWithProviders(
    <>
      <RoleForm formId="f" onSubmit={onSubmit} {...props} />
      <button type="submit" form="f">
        Save
      </button>
    </>
  );
  return onSubmit;
};

const coreError = (status: number, data: object) =>
  new AxiosError("Request failed", undefined, undefined, undefined, {
    status,
    data,
  } as never);

describe("RoleForm", () => {
  it("refuses a name core would reject", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    await user.type(screen.getByLabelText(/^Name/), "isaac admin");
    await user.type(screen.getByLabelText(/^Display Name/), "Isaac");

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("marks a refused name invalid, described by the rule", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText(/^Name/), "isaac admin");
    await user.type(screen.getByLabelText(/^Display Name/), "Isaac");

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByLabelText(/^Name/)).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(screen.getByLabelText(/^Name/)).toHaveAccessibleDescription(
      /^Starts with a letter/
    );
  });

  it.each(["isaac_admin", "isaac-admin"])(
    "submits the valid name %s",
    async (name) => {
      const user = userEvent.setup();
      const onSubmit = renderForm();
      await user.type(screen.getByLabelText(/^Name/), name);
      await user.type(screen.getByLabelText(/^Display Name/), "Isaac");

      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name }));
    }
  );

  it("shows core's issue under its field", () => {
    renderForm({ issues: [{ path: "displayName", message: "Too long" }] });

    expect(screen.getByText("Too long")).toBeVisible();
  });

  it("shows an error tied to no field above the fields", () => {
    renderForm({ error: "Something broke" });

    expect(screen.getByRole("alert")).toHaveTextContent("Something broke");
  });
});

const custom: Role = {
  id: "r1",
  name: "guest_files",
  displayName: "Guest files",
  description: null,
  isSystem: false,
  serviceId: null,
  service: null,
  isActive: true,
  archivedAt: null,
  retiredAt: null,
  requires2fa: false,
  guestAssignable: false,
  provisioned: false,
  unprovisionedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

describe("RoleForm guest-assignable", () => {
  it("is offered for a custom role and submitted when toggled", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm({ role: custom });

    await user.click(screen.getByLabelText("Guest-assignable"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith({ guestAssignable: true });
  });

  it("is offered when creating a role", () => {
    renderForm();

    expect(screen.getByLabelText("Guest-assignable")).toBeInTheDocument();
  });

  it.each([
    ["a system role", { isSystem: true, serviceId: "s1" }],
    ["a provisioned role", { provisioned: true }],
  ])("is absent for %s", (_case, patch) => {
    renderForm({ role: { ...custom, ...patch } });

    expect(screen.queryByLabelText("Guest-assignable")).toBeNull();
  });

  it("shows role_not_guest_assignable at form level", () => {
    const description = "Role holds permissions guests cannot have: users.read";
    const { error } = roleFormErrors(
      coreError(400, {
        error: "role_not_guest_assignable",
        error_description: description,
      }),
      "Failed"
    );
    renderForm({ role: custom, error });

    expect(screen.getByRole("alert")).toHaveTextContent(description);
  });
});

describe("roleFormErrors", () => {
  it("puts name_taken under the name", () => {
    expect(
      roleFormErrors(coreError(409, { error: "name_taken" }), "Failed")
    ).toEqual({
      issues: [{ path: "name", message: "A role with this name exists." }],
    });
  });

  it("keeps field issues under their fields with no banner", () => {
    const issues = [{ path: "name", message: "Bad name" }];

    expect(
      roleFormErrors(
        coreError(400, { error: "invalid_request", issues }),
        "Failed"
      )
    ).toEqual({ issues });
  });

  it("lists issues for fields the form has not in the banner", () => {
    const issues = [{ path: "description", message: "Too long" }];

    expect(
      roleFormErrors(
        coreError(400, { error: "invalid_request", issues }),
        "Failed"
      ).error
    ).toBe("description: Too long");
  });

  it("falls back to core's description", () => {
    expect(
      roleFormErrors(
        coreError(500, { error: "server_error", error_description: "Boom" }),
        "Failed"
      ).error
    ).toBe("Boom");
  });
});
