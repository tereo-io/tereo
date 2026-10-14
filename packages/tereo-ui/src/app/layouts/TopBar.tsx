import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { NavLink } from "react-router-dom";
import { docsNav } from "../routes/docs";
import { SECTIONS } from "../sections";
import { UserMenu } from "./UserMenu";
import { useAuth } from "@/lib/auth";
import "./TopBar.css";

export const TopBar = () => {
  const { hasPermission } = useAuth();
  const sectionsToShow = SECTIONS.filter((s) =>
    hasPermission(s.nav.permission)
  );

  return (
    <header className="t-topbar">
      <div className="t-topbar-brand">
        <span className="t-topbar-logo">Tereo</span>
      </div>
      <nav className="t-topbar-nav">
        {sectionsToShow.map((s) => (
          <NavLink key={s.nav.to} to={s.nav.to} className="t-topbar-link">
            <FontAwesomeIcon icon={s.nav.icon} />
            <span>{s.nav.label}</span>
          </NavLink>
        ))}
        <NavLink to={docsNav.to} className="t-topbar-link">
          <FontAwesomeIcon icon={docsNav.icon} />
          <span>{docsNav.label}</span>
        </NavLink>
      </nav>
      <div className="t-topbar-right">
        <ThemeToggleButton />
        <UserMenu />
      </div>
    </header>
  );
};
