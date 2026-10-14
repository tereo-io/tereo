import { z } from "zod";

/** A provider's slug, also the path segment of its `/oauth/upstream/{slug}` URLs. */
export const SlugSchema = z
  .string()
  .regex(
    /^[a-z0-9-]{1,50}$/,
    "Slug must be 1-50 lowercase letters, numbers and hyphens"
  );
