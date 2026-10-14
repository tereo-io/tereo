import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useLocalStorage } from "@kosmeo-ui/react";
import { Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import "./SectionLayout.css";
import {
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

  return (
    <>
      <aside className={`t-sidebar ${collapsed ? "t-sidebar-collapsed" : ""}`}>
        <div className="t-sidebar-header">
          <h3>{title}</h3>
          <button
            className="t-sidebar-collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <FontAwesomeIcon
              icon={collapsed ? faChevronRight : faChevronLeft}
            />
          </button>
        </div>
        {sidebar}
      </aside>
      <main className="t-main">
        <Outlet />
      </main>
    </>
  );
};
