import useMediaQuery, { NARROW_SCREEN } from "@/hooks/useMediaQuery";
import { faBars, faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { useEffect, useId, useState } from "react";
import { NavLink } from "react-router-dom";
import { docsNav } from "../routes/docs";
import { SECTIONS } from "../sections";
import { UserMenu } from "./UserMenu";
import { useAuth } from "@/lib/auth";
import "./TopBar.css";

export const TopBar = () => {
  const { hasPermission } = useAuth();
  const narrow = useMediaQuery(NARROW_SCREEN);
  const [menuOpen, setMenuOpen] = useState(false);
  const navId = useId();
  const open = narrow && menuOpen;
  const sectionsToShow = SECTIONS.filter((s) =>
    hasPermission(s.nav.permission)
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const links = [...sectionsToShow.map((s) => s.nav), docsNav];

  return (
    <header className="t-topbar">
      {narrow && (
        <button
          type="button"
          className="t-topbar-menu-btn"
          aria-label="Sections"
          aria-expanded={open}
          aria-controls={navId}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <FontAwesomeIcon icon={open ? faXmark : faBars} />
        </button>
      )}
      <div className="t-topbar-brand">
        <img className="t-topbar-mark" src="/favicon.svg" alt="" />
        <span className="t-topbar-logo">Tereo</span>
      </div>
      <nav
        id={navId}
        aria-label="Sections"
        className={`t-topbar-nav${narrow ? " t-topbar-nav-menu" : ""}${open ? " t-topbar-nav-open" : ""}`}
        hidden={narrow && !open}
      >
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className="t-topbar-link"
            onClick={() => setMenuOpen(false)}
          >
            <FontAwesomeIcon icon={link.icon} />
            <span>{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="t-topbar-right">
        <ThemeToggleButton />
        <UserMenu />
      </div>
    </header>
  );
};
