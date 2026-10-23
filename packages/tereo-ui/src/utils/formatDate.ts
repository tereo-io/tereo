const dateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const timestampFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** `Oct 22, 2026` */
export const formatDate = (date: string | Date): string =>
  dateFormat.format(new Date(date));

/** `Oct 22, 2026, 01:20 PM` */
export const formatDateTime = (date: string | Date): string =>
  dateTimeFormat.format(new Date(date));

/** `Oct 22, 2026, 01:20:27 PM`, for logs, where seconds tell entries apart. */
export const formatTimestamp = (date: string | Date): string =>
  timestampFormat.format(new Date(date));
