import type { CSSProperties, ReactNode } from "react";
import { brandingImageUrl, isSafeUrl } from "./urls";
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
  const logoUrl = authScope ? brandingImageUrl(branding?.logoUrl) : null;
  const logoDarkUrl = authScope
    ? brandingImageUrl(branding?.logoDarkUrl)
    : null;
  const backgroundUrl = authScope
    ? brandingImageUrl(branding?.backgroundUrl)
    : null;
  const links = authScope
    ? (branding?.footerLinks ?? []).filter((l) => isSafeUrl(l.url))
    : [];
  const background: CSSProperties | undefined = backgroundUrl
    ? { backgroundImage: cssUrl(backgroundUrl) }
    : undefined;
  const alt = appName ?? "Tereo";

  const card = (
    <div className={`k-auth-page-card k-auth-page-card-${width}`}>
      <div className="k-auth-page-header">
        {logoUrl && (
          // Both logos render; CSS keyed on the nearest data-theme picks one,
          // so the app's theme toggle and the preview frame decide, not the OS.
          <div
            className={`t-brand-logo${logoDarkUrl ? " t-brand-logo-has-dark" : ""}`}
          >
            <img className="t-brand-logo-light" src={logoUrl} alt={alt} />
            {logoDarkUrl && (
              <img className="t-brand-logo-dark" src={logoDarkUrl} alt={alt} />
            )}
          </div>
        )}
        <h1 className="k-auth-page-title">{title ?? alt}</h1>
        {subtitle && <p className="k-auth-page-subtitle">{subtitle}</p>}
      </div>
      <div className="k-auth-page-body">{children}</div>
    </div>
  );

  const pageFooter = (footer || links.length > 0) && (
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
  );

  if (layout === "split") {
    return (
      <div
        className={`k-auth-page t-brand-page${background ? " t-brand-split-with-image" : ""}`}
        data-brand-layout="split"
      >
        {background && (
          <div
            className="t-brand-split-image"
            data-testid="brand-split-image"
            style={background}
            aria-hidden="true"
          />
        )}
        <div className="t-brand-split-form">
          {card}
          {pageFooter}
        </div>
      </div>
    );
  }

  return (
    <div
      className="k-auth-page t-brand-page"
      data-brand-layout="centered"
      style={background}
    >
      {card}
      {pageFooter}
    </div>
  );
};
