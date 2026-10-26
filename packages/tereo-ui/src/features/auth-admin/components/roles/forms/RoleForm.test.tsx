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
