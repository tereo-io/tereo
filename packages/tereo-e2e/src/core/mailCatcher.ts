import { mkdirSync, rmSync, writeFileSync } from "fs";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { e2e } from "../config.js";
import path from "path";

export interface CaughtMail {
  to: string[];
  subject: string;
  text: string;
}

let sequence = 0;

/**
 * A plaintext SMTP server for the default email connection. It runs in the
 * webServer process, so every Playwright worker sees the same mail: each
 * message is written to `e2e.mailDir` as JSON, for the `mail` fixture to read.
 */
export async function startMailCatcher(): Promise<{ close(): Promise<void> }> {
  rmSync(e2e.mailDir, { recursive: true, force: true });
  mkdirSync(e2e.mailDir, { recursive: true });

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        simpleParser(Buffer.concat(chunks)).then((parsed) => {
          const mail: CaughtMail = {
            to: session.envelope.rcptTo.map((r) => r.address.toLowerCase()),
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
          };
          writeFileSync(
            path.join(
              e2e.mailDir,
              `${Date.now()}-${process.pid}-${sequence++}.json`
            ),
            JSON.stringify(mail)
          );
          callback();
        }, callback);
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(e2e.smtpPort, "127.0.0.1", resolve);
  });
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
