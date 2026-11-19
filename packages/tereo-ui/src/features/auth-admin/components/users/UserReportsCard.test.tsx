import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDetail, UserReport } from "../../api/users/types";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserReportsCard } from "./UserReportsCard";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { authMock } from "@/test/authMock";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("react-toastify", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuthModule()
);

const person: UserDetail = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  isActive: true,
  userType: "human",
  hasPassword: true,
  emailVerified: true,
  emailVerifiedAt: "2026-10-01T00:00:00Z",
  expiresAt: null,
  status: "active",
  passwordChangeRequired: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  managedBy: null,
  scimExcluded: null,
  reportsTo: null,
  directReportCount: 0,
};

const boss = {
  id: "m1",
  email: "boss@example.com",
  name: "Bo",
  isActive: true,
};

const report = (id: string, email: string): UserReport => ({
  id,
  email,
  name: null,
  isActive: true,
  userType: "human",
  reportsToId: "u1",
  depth: 1,
});

let reports: UserReport[] = [];

const renderCard = (user: UserDetail) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <UserReportsCard user={user} />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  reports = [];
  toastError.mockReset();
  authMock.permissions = ["users.reports.write"];
  authMock.axios.get.mockReset();
  authMock.axios.put.mockReset();
  authMock.axios.delete.mockReset();
  authMock.axios.get.mockImplementation(async (url: string) => {
    if (url === "/v1/admin/users/u1/reports")
      return { data: { data: reports } };
    if (url === "/v1/admin/users") {
      return { data: { data: [{ ...boss }], hasMore: false } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  authMock.axios.put.mockResolvedValue({ data: {} });
  authMock.axios.delete.mockResolvedValue({ data: undefined });
});

describe("UserReportsCard", () => {
  it("links the manager", async () => {
    renderCard({ ...person, reportsTo: boss });

    const link = await screen.findByRole("link", { name: "Bo" });
    expect(link).toHaveAttribute("href", "/auth-admin/users/m1");
  });

  it("falls back to the email and marks a deactivated manager", async () => {
    renderCard({
      ...person,
      reportsTo: { ...boss, name: null, isActive: false },
    });

    expect(
      await screen.findByRole("link", { name: "boss@example.com" })
    ).toBeVisible();
    expect(screen.getByText("(deactivated)")).toBeVisible();
  });

  it("says when the user reports to no one", async () => {
    renderCard(person);

    expect(await screen.findByText("Reports to no one")).toBeVisible();
    expect(screen.getByText("No one reports to this user")).toBeVisible();
  });

  it("lists direct reports", async () => {
    reports = [
      report("r1", "one@example.com"),
      report("r2", "two@example.com"),
    ];
    renderCard({ ...person, directReportCount: 2 });

    expect(await screen.findByText("Direct reports (2)")).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "one@example.com" })
    ).toHaveAttribute("href", "/auth-admin/users/r1");
    expect(screen.getByRole("link", { name: "two@example.com" })).toBeVisible();
  });

  it("hides Change and Clear without users.reports.write", async () => {
    authMock.permissions = ["users.read"];
    renderCard({ ...person, reportsTo: boss });

    await screen.findByText("Reporting line");
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("hides Change and Clear for a service account", async () => {
    renderCard({ ...person, userType: "service_account" });

    await screen.findByText("Reporting line");
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("hides Change and Clear for the system user", async () => {
    renderCard({ ...person, managedBy: { kind: "system" }, reportsTo: boss });

    await screen.findByText("Reporting line");
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("sets the manager from the picker", async () => {
    const user = userEvent.setup();
    renderCard(person);

    await user.click(await screen.findByRole("button", { name: "Change" }));
    expect(
      screen.getByText("Who does ada@example.com report to?")
    ).toBeVisible();
    await user.click(await screen.findByText("boss@example.com"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(authMock.axios.put).toHaveBeenCalledWith(
        "/v1/admin/users/u1/reports-to",
        { userId: "m1" }
      )
    );
  });

  it("clears the manager after a confirm", async () => {
    const user = userEvent.setup();
    renderCard({ ...person, reportsTo: boss });

    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(
      screen.getByText("Remove ada@example.com's reporting line?")
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(authMock.axios.delete).toHaveBeenCalledWith(
        "/v1/admin/users/u1/reports-to"
      )
    );
  });

  it("toasts core's error_description when the change would loop", async () => {
    const user = userEvent.setup();
    authMock.axios.put.mockRejectedValue({
      response: {
        data: {
          error: "reports_to_cycle",
          error_description: "That would make a loop",
        },
      },
    });
    renderCard(person);

    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.click(await screen.findByText("boss@example.com"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("That would make a loop")
    );
  });
});
