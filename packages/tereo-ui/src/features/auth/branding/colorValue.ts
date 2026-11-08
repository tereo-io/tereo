// A copy of core's isSafeColorValue grammar (utils/branding/colors.ts); core stays authoritative.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL = /^(?:rgba?|hsla?|oklch)\(([0-9.%deg ,/]+)\)$/;
export const COLOR_VALUE_MAX = 64;

// Whole-string match, so nothing can close the declaration or the rule.
export const isSafeColorValue = (value: string): boolean => {
  if (value.length === 0 || value.length > COLOR_VALUE_MAX) return false;
  if (HEX.test(value)) return true;
  const match = FUNCTIONAL.exec(value);
  return match !== null && /[0-9]/.test(match[1]);
};
