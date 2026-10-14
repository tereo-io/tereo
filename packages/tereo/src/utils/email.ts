import { z } from "zod";

const MAX_EMAIL_LENGTH = 255;

/**
 * An email as core stores and looks it up: trimmed and lower-cased, so two
 * spellings differing only in case are one address. `auth.users` enforces
 * the lower case (`users_email_lowercase`).
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(MAX_EMAIL_LENGTH);

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

export const emailDomain = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1).toLowerCase();
