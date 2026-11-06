import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_CLIENT } from "../../../handler.js";
import { urlPath } from "../../paths.js";
import type {
  Guest,
  GuestOptions,
  InviteGuestResult,
  PaginatedGuests,
  PasswordSetupLink,
} from "./types.js";

export * from "./types.js";

type InviteBody = Record<string, unknown>;

export const inviteGuest = async (
  body: InviteBody
): Promise<InviteGuestResult> => {
  const res = await tryHandleRequest<InviteGuestResult>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.guests.invite",
      method: "POST",
      url: "/v1/admin/guests",
      data: body,
    },
    "AS_0101",
    "Failed to invite guest"
  );
  return res.data;
};

export const getGuest = async (userId: string): Promise<Guest> => {
  const res = await tryHandleRequest<Guest>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.guests.get",
      method: "GET",
      url: urlPath`/v1/admin/guests/${userId}`,
    },
    "AS_0102",
    `Failed to fetch guest ${userId}`
  );
  return res.data;
};

export const extendGuest = async (
  userId: string,
  body: { expiresAt: string; name?: string }
): Promise<Guest> => {
  const res = await tryHandleRequest<Guest>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.guests.extend",
      method: "PATCH",
      url: urlPath`/v1/admin/guests/${userId}`,
      data: body,
    },
    "AS_0103",
    `Failed to extend guest ${userId}`
  );
  return res.data;
};

export const issueGuestPasswordSetupLink = async (
  userId: string,
  body: { notify?: boolean }
): Promise<PasswordSetupLink> => {
  const res = await tryHandleRequest<PasswordSetupLink>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.guests.issuePasswordSetupLink",
      method: "POST",
      url: urlPath`/v1/admin/guests/${userId}/password-setup-link`,
      data: body,
    },
    "AS_0104",
    `Failed to issue a password setup link for guest ${userId}`
  );
  return res.data;
};

export const listGuests = async (
  params: Record<string, string | number | boolean>
): Promise<PaginatedGuests> => {
  const res = await tryHandleRequest<PaginatedGuests>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.guests.list",
      method: "GET",
      url: "/v1/admin/guests",
      params,
    },
    "AS_0105",
    "Failed to list guests"
  );
  return res.data;
};

export const getGuestOptions = async (): Promise<GuestOptions> => {
  const res = await tryHandleRequest<GuestOptions>(
    {
      clientName: CORE_CLIENT,
      requestName: "core.guests.options",
      method: "GET",
      url: "/v1/admin/guests/options",
    },
    "AS_0106",
    "Failed to fetch guest options"
  );
  return res.data;
};
