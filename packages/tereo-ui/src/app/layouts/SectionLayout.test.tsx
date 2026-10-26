import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, NavLink, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { NARROW_SCREEN } from "@/hooks/useMediaQuery";
import userEvent from "@testing-library/user-event";
import { SectionLayout } from "./SectionLayout";

const stubScreen = (narrow: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === NARROW_SCREEN && narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

const renderLayout = () =>
  render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <Routes>
        <Route
          path="/admin"
          element={
            <SectionLayout
              title="Auth Admin"
              sidebar={
                <nav>
                  <NavLink to="/admin/users">Users</NavLink>
                  <NavLink to="/admin/roles">Roles</NavLink>
                </nav>
              }
            />
          }
        >
          <Route path="users" element={<p>Users page</p>} />
          <Route path="roles" element={<p>Roles page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );

const toggle = () => screen.getByRole("button", { name: "Auth Admin" });

describe("SectionLayout", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("on a wide screen", () => {
    beforeEach(() => stubScreen(false));

    it("shows the sidebar's links with no drawer toggle", () => {
      renderLayout();

      expect(screen.getByRole("link", { name: "Roles" })).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Auth Admin" })
      ).not.toBeInTheDocument();
    });
  });

  describe("on a narrow screen", () => {
    beforeEach(() => stubScreen(true));

    it("starts with the drawer closed", () => {
      renderLayout();

      expect(toggle()).toHaveAttribute("aria-expanded", "false");
    });

    it("keeps the closed drawer's links out of the tab order", () => {
      renderLayout();

      expect(
        screen.getByRole("complementary", { name: "Auth Admin", hidden: true })
      ).toHaveAttribute("inert");
    });

    it("opens the drawer from the toggle", async () => {
      const user = userEvent.setup();
      renderLayout();

      await user.click(toggle());

      expect(
        screen.getByRole("complementary", { name: "Auth Admin" })
      ).not.toHaveAttribute("inert");
    });

    it("closes the drawer once a link is followed", async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(toggle());

      await user.click(screen.getByRole("link", { name: "Roles" }));

      expect(toggle()).toHaveAttribute("aria-expanded", "false");
    });

    it("closes the drawer on Escape", async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(toggle());

      await user.keyboard("{Escape}");

      expect(toggle()).toHaveAttribute("aria-expanded", "false");
    });
  });
});
