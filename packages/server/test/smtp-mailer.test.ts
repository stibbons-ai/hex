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

/** Sends one mail with one attachment through the fake (or `host`), secured as `security` says. */
function send(security: SmtpSecurity, { password = PASSWORD, host = "127.0.0.1" } = {}) {
  const layer = smtpMailerLayer({
    host,
    port: smtp.port,
    security,
    user: Redacted.make(USER),
    password: Redacted.make(password),
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

  test.each([
    ["a long password", PASSWORD],
    ["a short password", "pw1"],
  ])(
    "a refused login names the stage, never the credentials the server echoed (%s)",
    async (_case, password) => {
      smtp.refuseLogins = true;
      try {
        const message = failure(await send("plain", { password }));
        expect(message).toContain(
          `sending to ${TO} via 127.0.0.1:${smtp.port} failed (EAUTH at AUTH PLAIN)`,
        );
        expect(message).toContain("535 5.7.8 authentication failed for *** (password ***)");
        const encoded = Buffer.from(`\u0000${USER}\u0000${password}`).toString("base64");
        for (const secret of [password, encoded, Buffer.from(password).toString("base64")]) {
          expect(message).not.toContain(secret);
        }
      } finally {
        smtp.refuseLogins = false;
      }
    },
  );

  test("plain to a host other than this machine sends nothing and never connects", async () => {
    const logins = smtp.logins.length;
    // 0.0.0.0 reaches the fake on this machine, but isn't a loopback address hex accepts for
    // plaintext: had hex connected, the fake would have recorded a login.
    const message = failure(await send("plain", { host: "0.0.0.0" }));
    expect(message).toContain(
      `sending to ${TO} via 0.0.0.0:${smtp.port} refused: plaintext SMTP is only allowed for a loopback host`,
    );
    expect(smtp.logins).toHaveLength(logins);
  });
});
