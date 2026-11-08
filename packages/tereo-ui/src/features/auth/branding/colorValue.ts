// A copy of core's isSafeColorValue grammar (utils/branding/colors.ts); core stays authoritative.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// A signed number, optionally followed by % or deg; hue angles may be negative.
const ARG = String.raw`[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:%|deg)?`;
const FUNCTIONAL = new RegExp(
  String.raw`^(?:rgba?|hsla?|oklch)\( ?${ARG}(?:(?: ?[,/] ?| +)${ARG})* ?\)$`
);
export const COLOR_VALUE_MAX = 64;

// Whole-string match, so nothing can close the declaration or the rule.
export const isSafeColorValue = (value: string): boolean => {
  if (value.length === 0 || value.length > COLOR_VALUE_MAX) return false;
  if (HEX.test(value)) return true;
  return FUNCTIONAL.test(value);
};
