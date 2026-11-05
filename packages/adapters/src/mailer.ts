import { isIPv4, isIPv6 } from "node:net";
import { Context, Data, Effect, Layer, Redacted } from "effect";
import { createTransport } from "nodemailer";
import type { NodemailerError } from "nodemailer";
import { credentialRedactions, excerpt, messageOf, redact } from "./errors";

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
 * only allowed for a host that is a loopback IP address ({@link isLoopbackHost}).
 */
export type SmtpSecurity = "tls" | "starttls" | "plain";

/**
 * Whether `host` is a loopback IP address: IPv4 in 127.0.0.0/8 or `::1`. Names never count, not
 * even `localhost`: nodemailer resolves a name first through DNS, before `/etc/hosts`, so it could
 * reach another machine.
 */
export function isLoopbackHost(host: string): boolean {
  return (isIPv4(host) && host.startsWith("127.")) || (isIPv6(host) && host === "::1");
}

/**
 * What a plaintext connection is only allowed to (see {@link isLoopbackHost}), as SMTP, IMAP and
 * the config say it.
 */
export const LOOPBACK_ONLY =
  "a loopback IP address (127.x.x.x or ::1; use 127.0.0.1, not a name such as localhost)";

/** Where and as whom the SMTP Mailer sends. */
export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly user: Redacted.Redacted<string>;
  readonly password: Redacted.Redacted<string>;
}

/**
 * The Mailer on an SMTP server: one connection per mail, secured as `security` says, logging in
 * as `user`. Attachments are only ever the bytes given; file and URL access are off. Timeouts
 * keep a dead server from holding a run: 30 s to connect and for the greeting, 60 s of silence.
 * `plain` for a host that isn't a loopback IP address sends nothing: every send fails without
 * connecting, so the credentials never cross a network unencrypted.
 */
export function smtpMailerLayer(settings: SmtpSettings): Layer.Layer<Mailer> {
  const { host, port, security } = settings;
  if (security === "plain" && !isLoopbackHost(host)) {
    return Layer.succeed(Mailer, {
      send: ({ to }) =>
        Effect.fail(
          new MailerError({
            message: `sending to ${to} via ${host}:${port} refused: plaintext SMTP is only allowed to ${LOOPBACK_ONLY}`,
          }),
        ),
    });
  }
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
  // What an error must never show, should a server echo it back.
  const secrets = credentialRedactions(user, password);
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
              // A view of the same bytes, not a copy.
              content: Buffer.from(content.buffer, content.byteOffset, content.byteLength),
            })),
          }),
        catch: (cause) => {
          const { code, command } = cause as NodemailerError;
          const stage = [code, command && `at ${command}`].filter(Boolean).join(" ");
          const shown = excerpt(redact(messageOf(cause), secrets));
          return new MailerError({
            message: `sending to ${to} via ${host}:${port} failed${stage ? ` (${stage})` : ""}: ${shown}`,
          });
        },
      }).pipe(Effect.asVoid),
  });
}
