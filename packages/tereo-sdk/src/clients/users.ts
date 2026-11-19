import type { UserReportsTo } from "../requests/auth/users/types.js";
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

  /**
   * Makes `reportsToId` the user's manager, replacing any current one. Core
   * refuses loops, service accounts, the system user and a guest manager
   * (400), and answers 422 `reports_limit_exceeded` past its size bound. Needs
   * `users.reports.write`, which no requestable role carries.
   *
   * In test mode (`createCoreClient({ testMode: true })`), resolves with no manager without calling core.
   */
  async setReportsTo(
    userId: string,
    reportsToId: string
  ): Promise<UserReportsTo> {
    if (this.testMode) return { userId, reportsTo: null };
    return requests.auth.setUserReportsTo(userId, reportsToId);
  }

  /**
   * Clears who the user reports to; succeeds when none was set. Needs
   * `users.reports.write`, which no requestable role carries.
   *
   * In test mode (`createCoreClient({ testMode: true })`), resolves without calling core.
   */
  async clearReportsTo(userId: string): Promise<void> {
    if (this.testMode) return;
    await requests.auth.clearUserReportsTo(userId);
  }
}
