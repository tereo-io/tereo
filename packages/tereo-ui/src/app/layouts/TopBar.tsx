import { AppTopBar, AppTopBarLink } from "@kosmeo-ui/react";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { NavLink } from "react-router-dom";
import { docsNav } from "../routes/docs";
import { SECTIONS } from "../sections";
import { UserMenu } from "./UserMenu";
import { useAuth } from "@/lib/auth";

export const TopBar = () => {
  const { hasPermission } = useAuth();
  const sectionsToShow = SECTIONS.filter((s) =>
    hasPermission(s.nav.permission)
  );
  const links = [...sectionsToShow.map((s) => s.nav), docsNav];

  return (
    <AppTopBar
      navLabel="Sections"
      brand={
        <>
          <img src="/favicon.svg" alt="" />
          <span>Tereo</span>
        </>
      }
      actions={
        <>
          <ThemeToggleButton />
          <UserMenu />
        </>
      }
    >
      {links.map((link) => (
        <AppTopBarLink key={link.to} as={NavLink} to={link.to} icon={link.icon}>
          {link.label}
        </AppTopBarLink>
      ))}
    </AppTopBar>
  );
};
