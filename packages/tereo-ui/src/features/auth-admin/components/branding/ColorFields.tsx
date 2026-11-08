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

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");

const channel = (v: string) =>
  v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v);

const hslToRgb = (h: number, s: number, l: number): number[] => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};

/**
 * A colour input's value (#rrggbb) from hex (3, 4, 6 or 8 digits; alpha is
 * dropped) or rgb()/hsl(); null when the picker cannot show it.
 */
export const swatchOf = (value: string | undefined): string | null => {
  const v = value?.trim();
  if (!v) return null;
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(v)?.[1];
  if (hex) {
    if (hex.length === 6 || hex.length === 8)
      return `#${hex.slice(0, 6)}`.toLowerCase();
    if (hex.length === 3 || hex.length === 4)
      return `#${hex
        .slice(0, 3)
        .split("")
        .map((c) => c + c)
        .join("")}`.toLowerCase();
    return null;
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/i.exec(v);
  if (!fn) return null;
  const parts = fn[2]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3);
  if (parts.length < 3) return null;
  let rgb: number[];
  if (fn[1].toLowerCase().startsWith("rgb")) {
    rgb = parts.map(channel);
  } else {
    const h = parseFloat(parts[0]);
    rgb = hslToRgb(
      ((h % 360) + 360) % 360,
      parseFloat(parts[1]) / 100,
      parseFloat(parts[2]) / 100
    );
  }
  return rgb.some((n) => Number.isNaN(n)) ? null : `#${rgb.map(hex2).join("")}`;
};

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
              // Unset shows what applies instead; with nothing to show, an
              // empty swatch, not black that reads as a choice.
              const swatch = own ? swatchOf(own) : swatchOf(inherited[token]);
              // A set value the picker cannot show gets a neutral swatch, not the unset one.
              const unset = !swatch && !own;
              return (
                <div key={token} className="t-color-row">
                  <input
                    type="color"
                    aria-label={`${token.slice(4)} picker`}
                    className={unset ? "t-color-unset" : undefined}
                    data-unset={unset ? "true" : undefined}
                    value={swatch ?? (own ? "#808080" : "#000000")}
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
