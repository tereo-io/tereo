import type { BrandingFooterLink } from "@/features/auth";
import { Button, Input } from "@kosmeo-ui/react";
import {
  FOOTER_LABEL_MAX,
  FOOTER_LINKS_MAX,
} from "../../api/branding/brandingErrors";

interface FooterLinksFieldProps {
  value: BrandingFooterLink[] | null;
  onChange: (value: BrandingFooterLink[] | null) => void;
  errors: Record<string, string>;
  readOnly: boolean;
}

export const FooterLinksField = ({
  value,
  onChange,
  errors,
  readOnly,
}: FooterLinksFieldProps) => {
  const links = value ?? [];
  const update = (next: BrandingFooterLink[]) =>
    onChange(next.length ? next : null);

  return (
    <div className="t-footer-links">
      {links.map((link, i) => (
        <div key={i} className="t-footer-link-row">
          <Input
            label="Link label"
            value={link.label}
            maxLength={FOOTER_LABEL_MAX}
            readOnly={readOnly}
            error={errors[`footerLinks.${i}.label`]}
            onChange={(e) =>
              update(
                links.map((l, j) =>
                  j === i ? { ...l, label: e.target.value } : l
                )
              )
            }
          />
          <Input
            label="Link URL"
            type="url"
            value={link.url}
            readOnly={readOnly}
            placeholder="https://"
            error={errors[`footerLinks.${i}.url`]}
            onChange={(e) =>
              update(
                links.map((l, j) =>
                  j === i ? { ...l, url: e.target.value } : l
                )
              )
            }
          />
          {!readOnly && (
            <Button
              variant="secondary"
              onClick={() => update(links.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {!readOnly && links.length < FOOTER_LINKS_MAX && (
        <Button
          variant="secondary"
          onClick={() => update([...links, { label: "", url: "" }])}
        >
          Add link
        </Button>
      )}
    </div>
  );
};
