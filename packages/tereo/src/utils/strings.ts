/**
 * `value` without any trailing `char`. A loop rather than `/x+$/`: V8 retries
 * that pattern from every position of a run that is not at the end, which is
 * quadratic in the run's length on request input.
 */
export const trimTrailing = (value: string, char: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end--;
  return end === value.length ? value : value.slice(0, end);
};
