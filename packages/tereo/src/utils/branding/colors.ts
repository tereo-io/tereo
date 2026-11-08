import { BRANDING_COLOR_TOKENS } from "../../definitions/brandingTokens.js";
import { z } from "zod";

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// A signed number, optionally followed by % or deg; hue angles may be negative.
const ARG = String.raw`[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:%|deg)?`;
const FUNCTIONAL = new RegExp(
  String.raw`^(?:rgba?|hsla?|oklch)\( ?${ARG}(?:(?: ?[,/] ?| +)${ARG})* ?\)$`
);
const MAX_VALUE_LENGTH = 64;

// Whole-string match, so nothing can close the declaration or the rule.
export function isSafeColorValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return false;
  if (HEX.test(value)) return true;
  return FUNCTIONAL.test(value);
}

const TOKENS = new Set(BRANDING_COLOR_TOKENS);

export const BrandingColorsSchema = z
  .record(z.string(), z.string())
  .superRefine((colors, ctx) => {
    const names = Object.keys(colors);
    if (names.length > BRANDING_COLOR_TOKENS.length) {
      ctx.addIssue({ code: "custom", message: "too many colour variables" });
    }
    for (const name of names) {
      if (!TOKENS.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `unknown colour variable ${name}`,
        });
      } else if (!isSafeColorValue(colors[name])) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `${name}: not an allowed colour value`,
        });
      }
    }
  })
  // For the provisioning JSON Schema; the check above is what enforces it.
  .meta({ propertyNames: { enum: [...BRANDING_COLOR_TOKENS] } });
