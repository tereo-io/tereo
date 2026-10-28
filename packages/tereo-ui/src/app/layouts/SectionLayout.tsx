import { SectionLayout as KosmeoSectionLayout } from "@kosmeo-ui/react";
import { Outlet } from "react-router-dom";
import type { ReactNode } from "react";

interface SectionLayoutProps {
  title: string;
  sidebar: ReactNode;
}

export const SectionLayout = ({ title, sidebar }: SectionLayoutProps) => (
  <KosmeoSectionLayout
    title={title}
    sidebar={sidebar}
    // The key tereo's own layout used, so a collapsed sidebar stays collapsed.
    collapsedStorageKey="t-sidebar-collapsed"
  >
    <Outlet />
  </KosmeoSectionLayout>
);
