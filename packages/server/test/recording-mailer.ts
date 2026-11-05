// The Mailer for tests: records every mail it accepts, and fails as scripted per recipient,
// standing in for the SMTP Mailer as the scripted DateExtractor stands in for the model.
import { Mailer, MailerError } from "@hex/adapters";
import type { OutgoingMail } from "@hex/adapters";
import { Effect, Layer } from "effect";

/** A recording Mailer: `sent` holds each accepted mail, in order. */
export function recordingMailer() {
  const sent: OutgoingMail[] = [];
  /** Recipient → how many more sends to it fail. */
  const failures = new Map<string, number>();
  return {
    sent,
    /** Fails the next `times` sends to `to`, as a server refusing them would. */
    failNext(to: string, times = 1) {
      failures.set(to, times);
    },
    layer: Layer.succeed(Mailer, {
      send: (mail) =>
        Effect.suspend(() => {
          const left = failures.get(mail.to) ?? 0;
          if (left > 0) {
            failures.set(mail.to, left - 1);
            return Effect.fail(
              new MailerError({
                message: `sending to ${mail.to} failed (EENVELOPE at RCPT TO): 451 try again later`,
              }),
            );
          }
          sent.push(mail);
          return Effect.void;
        }),
    }),
  };
}
