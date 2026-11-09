import { requests } from "../handler.js";

/** Admin actions on users. Needs `users.write` for the ones that change a user. */
export class UsersClient {
  /** `testMode` makes every method resolve without calling core. */
  constructor(private readonly testMode = false) {}

  /**
   * Emails the user a link to confirm their address. Core answers 409 when the
   * address is already verified, when no email is configured, or when the
   * user cannot be verified.
   *
   * In test mode (`createCoreClient({ testMode: true })`), resolves without calling core.
   */
  async sendVerificationEmail(userId: string): Promise<void> {
    if (this.testMode) return;
    await requests.auth.sendUserVerificationEmail(userId);
  }
}
