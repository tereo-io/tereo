export const DAY_SECONDS = 24 * 60 * 60;

const STANDARD_DAYS = [7, 30, 90];

export interface DurationOption {
  /** Seconds, as a string for the select. */
  value: string;
  label: string;
}

const describeSeconds = (seconds: number) =>
  seconds % DAY_SECONDS === 0
    ? `${seconds / DAY_SECONDS} day${seconds === DAY_SECONDS ? "" : "s"}`
    : `${Math.max(1, Math.floor(seconds / 3600))} hours`;

/**
 * 7, 30 and 90 days, less any past core's GUEST_MAX_TTL_SECONDS; with a cap
 * below them all, the cap alone. `max` unknown (still loading) offers all.
 */
export const guestDurationOptions = (
  max: number | undefined,
  suffix = ""
): DurationOption[] => {
  const fitting = STANDARD_DAYS.map((d) => d * DAY_SECONDS).filter(
    (s) => max === undefined || s <= max
  );
  const seconds = fitting.length > 0 ? fitting : [max as number];
  return seconds.map((s) => ({
    value: String(s),
    label: `${describeSeconds(s)}${suffix}`,
  }));
};

/** 30 days when offered, otherwise the longest option. */
export const defaultDuration = (options: DurationOption[]): string =>
  options.find((o) => o.value === String(30 * DAY_SECONDS))?.value ??
  options[options.length - 1].value;

/**
 * How far before core's cap an extension stops, so a browser clock running a
 * little ahead of core's does not push an expiry at the cap past it.
 */
export const CAP_MARGIN_SECONDS = 5 * 60;

/** `now + seconds`, held back from `now + max` by the margin. */
export const expiryAfter = (
  seconds: number,
  max: number | undefined,
  now = Date.now()
): Date => {
  const margin =
    max === undefined ? 0 : Math.min(CAP_MARGIN_SECONDS, Math.floor(max / 10));
  const capped = max === undefined ? seconds : Math.min(seconds, max - margin);
  return new Date(now + capped * 1000);
};
