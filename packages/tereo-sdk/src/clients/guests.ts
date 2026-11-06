import { requests } from "../handler.js";
import type {
  Guest,
  InviteGuestInput,
  InviteGuestResult,
  PasswordSetupLink,
} from "../requests/auth/guests/types.js";

const toIso = (at: Date | string): string =>
  at instanceof Date ? at.toISOString() : at;

/** Invites and manages guests: external people whose accounts expire. Needs the `guest_inviter` role. */
export class GuestsClient {
  async invite(input: InviteGuestInput): Promise<InviteGuestResult> {
    const body = { ...input };
    if (body.expiresAt !== undefined) body.expiresAt = toIso(body.expiresAt);
    return await requests.auth.inviteGuest(body);
  }

  async get(userId: string): Promise<Guest> {
    return await requests.auth.getGuest(userId);
  }

  async extend(userId: string, expiresAt: Date | string): Promise<Guest> {
    return await requests.auth.extendGuest(userId, {
      expiresAt: toIso(expiresAt),
    });
  }

  async issuePasswordSetupLink(
    userId: string,
    opts: { notify?: boolean } = {}
  ): Promise<PasswordSetupLink> {
    return await requests.auth.issueGuestPasswordSetupLink(userId, opts);
  }
}
