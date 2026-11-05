import { Context, Data, Effect, Layer, Redacted } from "effect";
import { createTransport } from "nodemailer";
import type { NodemailerError } from "nodemailer";
import { messageOf } from "./errors";

/** One attachment of an outgoing mail: its bytes, unchanged, under a file name and MIME type. */
export interface MailAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

/** One mail to send: plain text, attachments as given. */
export interface OutgoingMail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments: readonly MailAttachment[];
}

/**
 * Sending a mail failed. The message names the recipient and the SMTP stage, never the SMTP
 * credentials or the attachments' content; it carries no cause, since the workflow persists its
 * failure.
 */
export class MailerError extends Data.TaggedError("MailerError")<{
  readonly message: string;
}> {}

/** Sends mail. */
export class Mailer extends Context.Service<
  Mailer,
  {
    /** Sends `mail`; succeeds once the server accepted it for its recipient. */
    readonly send: (mail: OutgoingMail) => Effect.Effect<void, MailerError>;
  }
>()("hex/Mailer") {}

/**
 * How the connection is secured: `tls` is implicit TLS (port 465), `starttls` requires the
 * STARTTLS upgrade before anything else (never AUTH in plaintext), `plain` never encrypts and is
 * meant for a mail server on the same machine (the config only allows it for a loopback host).
 */
export type SmtpSecurity = "tls" | "starttls" | "plain";

/** Where and as whom the SMTP Mailer sends. */
export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly user: Redacted.Redacted<string>;
  readonly password: Redacted.Redacted<string>;
}

/** How much of a server's reply an error keeps. */
const MAX_SERVER_MESSAGE = 300;

/**
 * `message` with each of `secrets` (and its base64 form, as AUTH sends it) replaced by `***`.
 * Values under 8 characters are left alone, as `withoutApiKeys` does: too likely to match
 * ordinary text.
 */
function withoutSecrets(message: string, secrets: readonly string[]): string {
  const forms = secrets
    .flatMap((secret) => [secret, Buffer.from(secret).toString("base64")])
    .filter((form) => form.length >= 8);
  return forms.reduce((text, form) => text.replaceAll(form, "***"), message);
}

/**
 * The Mailer on an SMTP server: one connection per mail, secured as `security` says, logging in
 * as `user`. Attachments are only ever the bytes given; file and URL access are off. Timeouts
 * keep a dead server from holding a run: 30 s to connect and for the greeting, 60 s of silence.
 */
export function smtpMailerLayer(settings: SmtpSettings): Layer.Layer<Mailer> {
  const { host, port, security } = settings;
  const user = Redacted.value(settings.user);
  const password = Redacted.value(settings.password);
  const transport = createTransport({
    host,
    port,
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "plain",
    auth: { user, pass: password },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });
  // The forms AUTH PLAIN and LOGIN send, should a server echo them back.
  const secrets = [password, user, `\u0000${user}\u0000${password}`];
  return Layer.succeed(Mailer, {
    send: ({ from, to, subject, text, attachments }) =>
      Effect.tryPromise({
        try: () =>
          transport.sendMail({
            from,
            to,
            subject,
            text,
            attachments: attachments.map(({ fileName, contentType, content }) => ({
              filename: fileName,
              contentType,
              content: Buffer.from(content),
            })),
          }),
        catch: (cause) => {
          const { code, command } = cause as NodemailerError;
          const stage = [code, command && `at ${command}`].filter(Boolean).join(" ");
          const reason = withoutSecrets(messageOf(cause), secrets).trim() || "no message";
          const shown =
            reason.length > MAX_SERVER_MESSAGE ? `${reason.slice(0, MAX_SERVER_MESSAGE)}…` : reason;
          return new MailerError({
            message: `sending to ${to} via ${host}:${port} failed${stage ? ` (${stage})` : ""}: ${shown}`,
          });
        },
      }).pipe(Effect.asVoid),
  });
}
