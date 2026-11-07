import { requests } from "../handler.js";
import type {
  Guest,
  GuestOptions,
  InviteGuestInput,
  InviteGuestResult,
  ListGuestsOptions,
  PaginatedGuests,
  PasswordSetupLink,
} from "../requests/auth/guests/types.js";

const toIso = (at: Date | string): string =>
  at instanceof Date ? at.toISOString() : at;

// Core takes flat `filter[field]` / `filter[field_op]` params.
const listParams = (options: ListGuestsOptions) => {
  const params: Record<string, string | number | boolean> = {};
  if (options.limit != null) params.limit = options.limit;
  if (options.cursor) params.cursor = options.cursor;
  if (options.sort) params.sort = options.sort;
  if (options.sortDir) params.sortDir = options.sortDir;
  if (options.organizationId) {
    params["filter[organizationId]"] = options.organizationId;
  }
  if (options.email !== undefined) params["filter[email]"] = options.email;
  else if (options.emailContains !== undefined) {
    params["filter[email]"] = options.emailContains;
    params["filter[email_op]"] = "contains";
  }
  if (options.isActive !== undefined) {
    params["filter[isActive]"] = options.isActive;
  }
  for (const field of ["expiresAt", "createdAt"] as const) {
    const range = options[field];
    if (range?.gte !== undefined) {
      params[`filter[${field}_gte]`] = toIso(range.gte);
    }
    if (range?.lte !== undefined) {
      params[`filter[${field}_lte]`] = toIso(range.lte);
    }
  }
  return params;
};

/**
 * Invites and manages guests: external people whose accounts expire. Needs
 * the `guest_inviter` role, and reaches only organizations the service acts
 * in unless it holds `organizations.write`.
 */
export class GuestsClient {
  async invite(input: InviteGuestInput): Promise<InviteGuestResult> {
    const body = { ...input };
    if (body.expiresAt !== undefined) body.expiresAt = toIso(body.expiresAt);
    return await requests.auth.inviteGuest(body);
  }

  /** The guest-assignable roles, the default ones, and the longest expiry. */
  async options(): Promise<GuestOptions> {
    return await requests.auth.getGuestOptions();
  }

  async list(options: ListGuestsOptions = {}): Promise<PaginatedGuests> {
    return await requests.auth.listGuests(listParams(options));
  }

  async get(userId: string): Promise<Guest> {
    return await requests.auth.getGuest(userId);
  }

  /** Sets the guest's expiry, earlier or later; a past time ends access now. */
  async extend(
    userId: string,
    expiresAt: Date | string,
    opts: { name?: string } = {}
  ): Promise<Guest> {
    return await requests.auth.extendGuest(userId, {
      expiresAt: toIso(expiresAt),
      ...(opts.name !== undefined && { name: opts.name }),
    });
  }

  async issuePasswordSetupLink(
    userId: string,
    opts: { notify?: boolean } = {}
  ): Promise<PasswordSetupLink> {
    return await requests.auth.issueGuestPasswordSetupLink(userId, opts);
  }
}
