import { requests } from "../handler.js";

/** Admin actions on users. Needs `users.write` for the ones that change a user. */
export class UsersClient {
  /**
   * Emails the user a link to confirm their address. Core answers 409 when the
   * address is already verified, when no email is configured, or when the
   * user cannot be verified.
   */
  async sendVerificationEmail(userId: string): Promise<void> {
    await requests.auth.sendUserVerificationEmail(userId);
  }
}
