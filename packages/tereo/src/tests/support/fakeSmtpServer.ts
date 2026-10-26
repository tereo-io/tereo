import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "net";

export interface CapturedMessage {
  parsed: ParsedMail;
  raw: string;
  from: string;
  /** Every envelope recipient, Bcc included. */
  rcpt: string[];
  /** Credentials the client authenticated with, if any. */
  auth?: { user: string; pass: string };
}

export interface FakeSmtpServer {
  port: number;
  messages: CapturedMessage[];
  close(): Promise<void>;
}

const authOf = (user: unknown): CapturedMessage["auth"] => {
  if (typeof user !== "string") return undefined;
  const [name, pass] = user.split("\n");
  return { user: name, pass };
};

/**
 * A plain-text SMTP server on a random localhost port. `reply` picks the
 * SMTP status for each message: 250 accepts, 4xx / 5xx reject.
 */
export async function startFakeSmtpServer(
  opts: {
    reply?: (msg: CapturedMessage) => number;
    /** Refuse RCPT TO for this address with a 550. */
    refuseRecipient?: (address: string) => boolean;
    /** Hold the reply to each message this long. */
    delayMs?: number;
  } = {}
): Promise<FakeSmtpServer> {
  const messages: CapturedMessage[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onRcptTo(address, _session, callback) {
      if (opts.refuseRecipient?.(address.address)) {
        callback(
          Object.assign(new Error("mailbox unavailable"), { responseCode: 550 })
        );
        return;
      }
      callback();
    },
    onAuth(auth, _session, callback) {
      callback(null, { user: `${auth.username}\n${auth.password}` });
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks);
        simpleParser(raw).then((parsed) => {
          const msg: CapturedMessage = {
            parsed,
            raw: raw.toString("utf8"),
            from: session.envelope.mailFrom
              ? session.envelope.mailFrom.address
              : "",
            rcpt: session.envelope.rcptTo.map((r) => r.address),
            auth: authOf(session.user),
          };
          const code = opts.reply?.(msg) ?? 250;
          if (code >= 400) {
            callback(
              Object.assign(new Error(`rejected with ${code}`), {
                responseCode: code,
              })
            );
            return;
          }
          messages.push(msg);
          setTimeout(() => callback(), opts.delayMs ?? 0);
        }, callback);
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.server.address() as AddressInfo).port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
