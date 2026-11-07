import { isSafeColorValue } from "../../api/branding/brandingErrors";
import type { BrandingSource } from "../../api/branding/types";
import { BRANDING_COLOR_TOKENS } from "@/features/auth";
import { Input } from "@kosmeo-ui/react";

const GROUPS = [
  "primary",
  "secondary",
  "background",
  "border",
  "text",
  "danger",
  "success",
  "warning",
  "light",
  "shadow",
] as const;

const groupOf = (token: string) => token.split("-")[3];

const title = (group: string) => group[0].toUpperCase() + group.slice(1);

const SOURCE_LABEL: Partial<Record<BrandingSource, string>> = {
  default: "from Default",
  tereo: "Tereo",
};

interface ColorFieldsProps {
  /** The profile's own values for this mode. */
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  /** Effective values and where each comes from, for the placeholder. */
  inherited: Record<string, string>;
  sources: Record<string, BrandingSource>;
  errors: Record<string, string>;
  errorPrefix: string;
  readOnly: boolean;
}

export const placeholderFor = (
  inherited: string | undefined,
  source: BrandingSource | undefined
) => {
  const label = source ? SOURCE_LABEL[source] : undefined;
  if (inherited && label) return `${inherited} (${label})`;
  return inherited ?? label ?? "";
};

export const ColorFields = ({
  value,
  onChange,
  inherited,
  sources,
  errors,
  errorPrefix,
  readOnly,
}: ColorFieldsProps) => {
  const set = (token: string, next: string) => {
    const copy = { ...value };
    if (next.trim() === "") delete copy[token];
    else copy[token] = next;
    onChange(copy);
  };

  return (
    <div className="t-color-groups">
      {GROUPS.map((group) => (
        <section key={group} className="t-color-group">
          <h3>{title(group)}</h3>
          {BRANDING_COLOR_TOKENS.filter((t) => groupOf(t) === group).map(
            (token) => {
              const own = value[token] ?? "";
              const swatch =
                isSafeColorValue(own) && own.startsWith("#") && own.length === 7
                  ? own
                  : "#000000";
              return (
                <div key={token} className="t-color-row">
                  <input
                    type="color"
                    aria-label={`${token.slice(4)} picker`}
                    value={swatch}
                    disabled={readOnly}
                    onChange={(e) => set(token, e.target.value)}
                  />
                  <Input
                    label={token.slice(4)}
                    value={own}
                    readOnly={readOnly}
                    placeholder={placeholderFor(
                      inherited[token],
                      sources[token]
                    )}
                    error={errors[`${errorPrefix}.${token}`]}
                    onChange={(e) => set(token, e.target.value)}
                  />
                </div>
              );
            }
          )}
        </section>
      ))}
    </div>
  );
};
