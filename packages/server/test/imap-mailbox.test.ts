// The IMAP Mailbox against fake servers that refuse to move or search, or drop the connection:
// the error says why, as the server put it, and whether the connection is gone.
import { afterAll, expect, test } from "bun:test";
import { Mailbox, imapMailboxLayer } from "@hex/adapters";
import type { MailboxError } from "@hex/adapters";
import { Effect, Redacted } from "effect";
import { fakeImap } from "./fake-imap";
import type { FakeImap, FakeImapOptions } from "./fake-imap";
import { within } from "./timeouts";

const servers: FakeImap[] = [];

afterAll(() => {
  for (const imap of servers) imap.server.stop(true);
});

/** The error of `operation` on the IMAP Mailbox of a fake server started with `options`. */
async function failureOn(
  options: FakeImapOptions,
  operation: (mailbox: Mailbox["Service"]) => Effect.Effect<unknown, MailboxError>,
) {
  const imap = fakeImap(options);
  servers.push(imap);
  const layer = imapMailboxLayer({
    host: "127.0.0.1",
    port: imap.port,
    security: "plain",
    user: Redacted.make("intake@example.com"),
    password: Redacted.make("imap-secret-0123456789"),
    folder: "INBOX",
  });
  const failing = Effect.runPromise(
    Mailbox.use(operation).pipe(Effect.flip, Effect.provide(layer)),
  );
  return { imap, error: await within(failing, "the mailbox operation to fail", 10_000) };
}

test("a move the server refuses fails naming the server's reason", async () => {
  const { imap, error } = await failureOn({ messageId: "quota@shop.example" }, (mailbox) =>
    mailbox.moveMessageId("<quota@shop.example>", "processed"),
  );
  expect(error.message).toBe(
    `127.0.0.1:${imap.port}, folder INBOX: moving mail to hex/processed failed: the server refused the move: [OVERQUOTA] Quota exceeded (mailbox full)`,
  );
  expect(error.connectionLost).toBe(false);
  expect(imap.commands.some((line) => /^\S+ UID MOVE 1 /.test(line))).toBe(true);
});

test("a search the server refuses fails naming the server's reason", async () => {
  const { imap, error } = await failureOn({ refuseSearch: true }, (mailbox) =>
    mailbox.moveMessageId("<quota@shop.example>", "processed"),
  );
  expect(error.message).toBe(
    `127.0.0.1:${imap.port}, folder INBOX: moving mail to hex/processed failed: the server refused the search: [CANNOT] Search is not available right now`,
  );
  expect(error.connectionLost).toBe(false);
});

test("a connection the server drops ends the wait for news, saying the connection closed", async () => {
  const { imap, error } = await failureOn({ dropOnIdle: true }, (mailbox) =>
    mailbox.waitForChange(60_000),
  );
  expect(error.message).toStartWith(
    `127.0.0.1:${imap.port}, folder INBOX: waiting for new mail failed: the connection closed (read ECONNRESET)`,
  );
  expect(error.connectionLost).toBe(true);
});
