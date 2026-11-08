import type { CaughtMail } from "../core/mailCatcher.js";
import { readdirSync, readFileSync } from "fs";
import { expect } from "@playwright/test";
import { e2e } from "../config.js";

export type { CaughtMail };

const readAll = (): CaughtMail[] => {
  let names: string[];
  try {
    names = readdirSync(e2e.mailDir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(`${e2e.mailDir}/${name}`, "utf-8"))];
    } catch {
      // Caught mid-write; the next poll sees it whole.
      return [];
    }
  });
};

export class Mail {
  /**
   * The newest message to `to` whose subject matches, waiting for it to
   * arrive. `after` skips messages already seen, so a second send to the same
   * address is not mistaken for the first.
   */
  async waitForMessage(
    to: string,
    options: { subject?: string | RegExp; after?: number } = {}
  ): Promise<CaughtMail> {
    const wanted = to.toLowerCase();
    const match = (m: CaughtMail) =>
      m.to.includes(wanted) &&
      (options.subject === undefined ||
        (typeof options.subject === "string"
          ? m.subject === options.subject
          : options.subject.test(m.subject)));
    let found: CaughtMail[] = [];
    await expect
      .poll(
        () => {
          found = readAll()
            .filter(match)
            .slice(options.after ?? 0);
          return found.length;
        },
        { message: `mail to ${to}`, timeout: 30_000 }
      )
      .toBeGreaterThan(0);
    return found[found.length - 1];
  }

  /** How many messages to `to` match so far, to pass as `after`. */
  count(to: string, subject?: string | RegExp): number {
    const wanted = to.toLowerCase();
    return readAll().filter(
      (m) =>
        m.to.includes(wanted) &&
        (subject === undefined ||
          (typeof subject === "string"
            ? m.subject === subject
            : subject.test(m.subject)))
    ).length;
  }
}

/** The first http(s) link in a message's text. */
export const linkIn = (mail: CaughtMail): string => {
  const link = mail.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`No link in "${mail.subject}": ${mail.text}`);
  return link;
};
