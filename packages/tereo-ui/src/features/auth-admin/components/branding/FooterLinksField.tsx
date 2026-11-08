import { Button, Input, RadioGroup } from "@kosmeo-ui/react";
import type { BrandingFooterLink } from "@/features/auth";
import {
  FOOTER_LABEL_MAX,
  FOOTER_LINKS_MAX,
} from "../../api/branding/brandingErrors";

type Mode = "inherit" | "none" | "custom";

const MODES: { value: Mode; label: string }[] = [
  { value: "inherit", label: "Inherit" },
  { value: "none", label: "No links" },
  { value: "custom", label: "These links" },
];

interface FooterLinksFieldProps {
  /** null inherits the links beneath this profile; [] shows none. */
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
  const mode: Mode =
    value === null ? "inherit" : value.length === 0 ? "none" : "custom";
  const links = value ?? [];

  const choose = (next: Mode) => {
    if (next === "inherit") onChange(null);
    else if (next === "none") onChange([]);
    else if (mode !== "custom") onChange([{ label: "", url: "" }]);
  };

  return (
    <div className="t-footer-links">
      <RadioGroup<Mode>
        label="Links shown"
        name="footer-links-mode"
        options={MODES}
        value={mode}
        disabled={readOnly}
        onChange={choose}
      />
      {links.map((link, i) => (
        <div key={i} className="t-footer-link-row">
          <Input
            label="Link label"
            value={link.label}
            maxLength={FOOTER_LABEL_MAX}
            readOnly={readOnly}
            error={errors[`footerLinks.${i}.label`]}
            onChange={(e) =>
              onChange(
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
              onChange(
                links.map((l, j) =>
                  j === i ? { ...l, url: e.target.value } : l
                )
              )
            }
          />
          {!readOnly && (
            <Button
              variant="secondary"
              onClick={() => onChange(links.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {!readOnly && mode === "custom" && links.length < FOOTER_LINKS_MAX && (
        <Button
          variant="secondary"
          onClick={() => onChange([...links, { label: "", url: "" }])}
        >
          Add link
        </Button>
      )}
    </div>
  );
};
