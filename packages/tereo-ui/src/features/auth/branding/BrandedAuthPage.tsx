import type { CSSProperties, ReactNode } from "react";
import { useBranding } from "./useBranding";

interface Props {
  title?: ReactNode;
  subtitle?: ReactNode;
  width?: "narrow" | "wide";
  children: ReactNode;
  footer?: ReactNode;
}

const cssUrl = (url: string) =>
  `url("${url.replace(/["\\\n]/g, encodeURIComponent)}")`;

/** The sign-in shell: kosmeo's auth card plus a client's logo, background and links. */
export const BrandedAuthPage = ({
  title,
  subtitle,
  width = "narrow",
  children,
  footer,
}: Props) => {
  const branding = useBranding();
  const appName = branding?.appName ?? null;
  const authScope = branding?.scope === "auth";
  const layout = authScope ? (branding?.layout ?? "centered") : "centered";
  const logoUrl = authScope ? branding?.logoUrl : null;
  const links = authScope ? (branding?.footerLinks ?? []) : [];
  const style: CSSProperties | undefined =
    authScope && branding?.backgroundUrl
      ? { backgroundImage: cssUrl(branding.backgroundUrl) }
      : undefined;

  return (
    <div
      className="k-auth-page t-brand-page"
      data-brand-layout={layout}
      style={style}
    >
      <div className={`k-auth-page-card k-auth-page-card-${width}`}>
        <div className="k-auth-page-header">
          {logoUrl && (
            <picture className="t-brand-logo">
              {branding?.logoDarkUrl && (
                <source
                  media="(prefers-color-scheme: dark)"
                  srcSet={branding.logoDarkUrl}
                />
              )}
              <img src={logoUrl} alt={appName ?? "Tereo"} />
            </picture>
          )}
          <h1 className="k-auth-page-title">{title ?? appName ?? "Tereo"}</h1>
          {subtitle && <p className="k-auth-page-subtitle">{subtitle}</p>}
        </div>
        <div className="k-auth-page-body">{children}</div>
      </div>
      {(footer || links.length > 0) && (
        <div className="k-auth-page-footer">
          {footer}
          {links.length > 0 && (
            <nav className="t-brand-links">
              {links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.label}
                </a>
              ))}
            </nav>
          )}
        </div>
      )}
    </div>
  );
};
