import useMediaQuery, { NARROW_SCREEN } from "@/hooks/useMediaQuery";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useId, useState } from "react";
import { useLocalStorage } from "@kosmeo-ui/react";
import { Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import "./SectionLayout.css";
import {
  faBars,
  faChevronLeft,
  faChevronRight,
} from "@fortawesome/free-solid-svg-icons";

interface SectionLayoutProps {
  title: string;
  sidebar: ReactNode;
}

export const SectionLayout = ({ title, sidebar }: SectionLayoutProps) => {
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(
    "t-sidebar-collapsed"
  );
  const narrow = useMediaQuery(NARROW_SCREEN);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarId = useId();
  const open = narrow && drawerOpen;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const sidebarClasses = [
    "t-sidebar",
    !narrow && collapsed && "t-sidebar-collapsed",
    narrow && "t-sidebar-drawer",
    open && "t-sidebar-open",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {narrow && (
        <div className="t-section-bar">
          <button
            type="button"
            className="t-section-bar-toggle"
            aria-expanded={open}
            aria-controls={sidebarId}
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            <FontAwesomeIcon icon={faBars} />
            {title}
          </button>
        </div>
      )}
      {open && (
        <div
          className="t-sidebar-backdrop"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        id={sidebarId}
        className={sidebarClasses}
        aria-label={title}
        // Off screen while closed, so its links stay out of the tab order.
        inert={narrow && !open}
        onClick={(e) => {
          if ((e.target as Element).closest("a")) setDrawerOpen(false);
        }}
      >
        <div className="t-sidebar-header">
          <h3>{title}</h3>
          {!narrow && (
            <button
              className="t-sidebar-collapse-btn"
              onClick={() => setCollapsed(!collapsed)}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <FontAwesomeIcon
                icon={collapsed ? faChevronRight : faChevronLeft}
              />
            </button>
          )}
        </div>
        {sidebar}
      </aside>
      <main className="t-main">
        <Outlet />
      </main>
    </>
  );
};
