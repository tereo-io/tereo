import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { pgText } from "../../../../utils/pgInput.js";
import { z } from "zod";

// Core's own delivery headers, and the hop-by-hop and framing headers that
// belong to the connection: a custom value for one would break the request or
// how the receiver reads it.
const BLOCKED_HEADERS = [
  "content-type",
  "content-length",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  // undici's fetch throws on any Expect header, so every delivery would fail.
  "expect",
  "x-webhook-id",
  "x-webhook-event",
  "x-webhook-timestamp",
  "x-webhook-signature",
];
const BLOCKED_HEADER_PREFIXES = ["proxy-"];

const isBlockedHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return (
    BLOCKED_HEADERS.includes(lower) ||
    BLOCKED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
};

export const customHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9-]+$/),
    // What fetch accepts in a header value; a CR, LF or a character above
    // U+00FF would make every delivery throw and auto-disable the endpoint.
    pgText()
      .max(500)
      .regex(
        /^[\t\x20-\x7e\x80-\xff]*$/,
        "Header values may contain only tabs and printable Latin-1 characters"
      )
  )
  .refine(
    (h) => Object.keys(h).length <= 10,
    "Maximum 10 custom headers allowed"
  )
  .refine(
    (h) => !Object.keys(h).some(isBlockedHeader),
    "Cannot set reserved, hop-by-hop or framing headers"
  )
  // Header names are case-insensitive: two that differ only in case would
  // both be sent.
  .refine(
    (h) =>
      new Set(Object.keys(h).map((k) => k.toLowerCase())).size ===
      Object.keys(h).length,
    "Header names must differ by more than case"
  );

export const createWebhookEndpointSchema = z.object({
  url: pgText().url().max(2048),
  description: pgText().max(500).optional(),
  eventTypes: z
    .array(pgText().max(100))
    .min(1, "At least one event type is required")
    .max(100, "At most 100 event types"),
  customHeaders: customHeadersSchema.optional(),
});

export const getWebhookEndpointsQuerySchema = createCursorQuerySchema({
  filters: {
    status: {
      operators: ["equals", "in"],
      schema: z.enum(["ACTIVE", "PAUSED", "DISABLED"]),
    },
    url: {
      operators: ["contains"],
      schema: pgText(),
    },
    description: {
      operators: ["contains"],
      schema: pgText(),
    },
    eventType: {
      operators: ["equals", "contains"],
      schema: pgText(),
      toWhere: (clause) => ({ subscriptions: { some: { eventType: clause } } }),
    },
    archived: {
      operators: ["equals"],
      schema: z.boolean(),
      toWhere: ({ equals }) => ({
        archivedAt: equals ? { not: null } : null,
      }),
    },
  },
  sortFields: {
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  defaultSort: "createdAt",
  defaultLimit: 25,
  maxLimit: 100,
});

const booleanQuery = z.enum(["true", "false"]);

export const listWebhookEndpointsExtraQuerySchema = z
  .object({
    // Kept for clients that predate filter[archived], which takes precedence.
    includeArchived: booleanQuery
      .optional()
      .default("false")
      .transform((v) => v === "true"),
    // As the cursor query accepts it, a repeated key included; it applies
    // the filter, this only tells whether one was given.
    "filter[archived]": z
      .union([booleanQuery, z.array(booleanQuery)])
      .optional(),
  })
  .transform(({ includeArchived, "filter[archived]": archived }) => ({
    includeArchived,
    archivedFiltered: archived !== undefined,
  }));
