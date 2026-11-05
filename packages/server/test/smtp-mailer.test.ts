// The SMTP Mailer against a fake SMTP server on loopback: what it refuses to do without TLS, and
// what its errors never show.
import { afterAll, describe, expect, test } from "bun:test";
import { Mailer, smtpMailerLayer } from "@hex/adapters";
import type { SmtpSecurity } from "@hex/adapters";
import { Effect, Exit, Redacted } from "effect";
import { fakeSmtp } from "./fake-smtp";

const smtp = fakeSmtp();
afterAll(() => smtp.server.stop(true));

const USER = "hex@example.com";
const PASSWORD = "smtp-secret-0123456789";
const TO = "autobox@sevdesk.example";

/** Sends one mail with one attachment through the fake, secured as `security` says. */
function send(security: SmtpSecurity) {
  const layer = smtpMailerLayer({
    host: "127.0.0.1",
    port: smtp.port,
    security,
    user: Redacted.make(USER),
    password: Redacted.make(PASSWORD),
  });
  return Effect.runPromiseExit(
    Mailer.use((mailer) =>
      mailer.send({
        from: "hex@example.com",
        to: TO,
        subject: "Rechnung",
        text: "Forwarded by hex.",
        attachments: [
          {
            fileName: "Rechnung.pdf",
            contentType: "application/pdf",
            content: new TextEncoder().encode("%PDF-1.4\n"),
          },
        ],
      }),
    ).pipe(Effect.provide(layer)),
  );
}

/** The failure message of `exit`, failing the test when it succeeded. */
function failure(exit: Exit.Exit<void, { message: string }>): string {
  if (Exit.isSuccess(exit)) throw new Error("expected the send to fail");
  return String(exit.cause);
}

describe("smtpMailerLayer", () => {
  test.each([
    ["starttls", "a server that offers no STARTTLS", "(ETLS at STARTTLS)"],
    ["tls", "a server that speaks no TLS", "(ESOCKET at CONN)"],
  ] as const)("%s refuses %s: no login, no mail", async (security, _case, stage) => {
    const logins = smtp.logins.length;
    const mails = smtp.mails.length;
    const message = failure(await send(security));
    expect(message).toContain(`sending to ${TO} via 127.0.0.1:${smtp.port} failed ${stage}`);
    expect(smtp.logins).toHaveLength(logins);
    expect(smtp.mails).toHaveLength(mails);
  });

  test("a refused login names the stage, never the credentials the server echoed", async () => {
    smtp.refuseLogins = true;
    try {
      const message = failure(await send("plain"));
      expect(message).toContain(
        `sending to ${TO} via 127.0.0.1:${smtp.port} failed (EAUTH at AUTH PLAIN)`,
      );
      expect(message).toContain("535 5.7.8 authentication failed for ***");
      const encoded = Buffer.from(`\u0000${USER}\u0000${PASSWORD}`).toString("base64");
      for (const secret of [PASSWORD, encoded, Buffer.from(PASSWORD).toString("base64")]) {
        expect(message).not.toContain(secret);
      }
    } finally {
      smtp.refuseLogins = false;
    }
  });
});
