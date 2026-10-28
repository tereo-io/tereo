import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NARROW_SCREEN } from "@kosmeo-ui/react";
import { MemoryRouter } from "react-router-dom";
import { TopBar } from "./TopBar";

vi.mock("@/lib/auth", async () => ({
  ...(await import("@/test/authMock")).mockAuthModule(),
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ resolvedTheme: "light", toggleTheme: () => {} }),
}));
vi.mock("./UserMenu", () => ({
  UserMenu: () => <button aria-label="User menu" />,
}));

const stubScreen = (narrow: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === NARROW_SCREEN && narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

const renderBar = () =>
  render(
    <MemoryRouter>
      <TopBar />
    </MemoryRouter>
  );

const menu = () => screen.getByRole("button", { name: "Sections" });

describe("TopBar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the sections inline on a wide screen", () => {
    stubScreen(false);
    renderBar();

    expect(screen.getByRole("link", { name: "Auth Admin" })).toBeVisible();
  });

  describe("on a narrow screen", () => {
    beforeEach(() => stubScreen(true));

    it("folds the sections behind a menu button", () => {
      renderBar();

      expect(
        screen.queryByRole("link", { name: "Auth Admin" })
      ).not.toBeInTheDocument();
    });

    it.each(["User menu", "Switch to dark mode"])(
      "keeps %s in reach",
      (name) => {
        renderBar();

        expect(screen.getByRole("button", { name })).toBeVisible();
      }
    );

    it("opens the sections from the menu button", async () => {
      const user = userEvent.setup();
      renderBar();

      await user.click(menu());

      expect(screen.getByRole("link", { name: "Auth Admin" })).toBeVisible();
    });

    it("closes once a section is picked", async () => {
      const user = userEvent.setup();
      renderBar();
      await user.click(menu());

      await user.click(screen.getByRole("link", { name: "Auth Admin" }));

      expect(menu()).toHaveAttribute("aria-expanded", "false");
    });
  });
});
