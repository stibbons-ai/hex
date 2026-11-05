// The IMAP Mailbox against a fake server that refuses to move the mail: the error says why, as
// the server put it.
import { afterAll, expect, test } from "bun:test";
import { Mailbox, imapMailboxLayer } from "@hex/adapters";
import { Effect, Redacted } from "effect";
import { fakeImap } from "./fake-imap";
import { within } from "./timeouts";

const imap = fakeImap({ messageId: "quota@shop.example" });

afterAll(() => {
  imap.server.stop(true);
});

test("a move the server refuses fails naming the server's reason", async () => {
  const layer = imapMailboxLayer({
    host: "127.0.0.1",
    port: imap.port,
    security: "plain",
    user: Redacted.make("intake@example.com"),
    password: Redacted.make("imap-secret-0123456789"),
    folder: "INBOX",
  });
  const moving = Effect.runPromise(
    Mailbox.use((mailbox) => mailbox.moveMessageId("<quota@shop.example>", "processed")).pipe(
      Effect.flip,
      Effect.provide(layer),
    ),
  );
  const error = await within(moving, "the refused move", 10_000);
  expect(error.message).toBe(
    `127.0.0.1:${imap.port}, folder INBOX: moving mail to hex/processed failed: the server refused the move: [OVERQUOTA] Quota exceeded (mailbox full)`,
  );
  expect(error.connectionLost).toBe(false);
  expect(imap.commands.some((line) => /^\S+ UID MOVE 1 /.test(line))).toBe(true);
});
