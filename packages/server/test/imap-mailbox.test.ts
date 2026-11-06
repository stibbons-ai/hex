// The IMAP Mailbox against fake servers that refuse to move or search, drop the connection,
// renumber the folder or never answer: the error says why, as the server put it, and whether the
// connection is gone or the listing stale.
import { afterAll, expect, test } from "bun:test";
import { Mailbox, imapMailboxLayer } from "@hex/adapters";
import type { MailboxError } from "@hex/adapters";
import { Duration, Effect, Redacted } from "effect";
import { fakeImap } from "./fake-imap";
import type { FakeImap, FakeImapOptions } from "./fake-imap";
import { within } from "./timeouts";

const servers: FakeImap[] = [];

afterAll(() => {
  for (const imap of servers) imap.server.stop(true);
});

/**
 * The error of `operation` on the IMAP Mailbox of a fake server started with `options`, its
 * connect deadline `connectDeadline` (default the layer's own).
 */
async function failureOn(
  options: FakeImapOptions,
  operation: (mailbox: Mailbox["Service"]) => Effect.Effect<unknown, MailboxError>,
  connectDeadline?: Duration.Duration,
) {
  const imap = fakeImap(options);
  servers.push(imap);
  const layer = imapMailboxLayer(
    {
      host: "127.0.0.1",
      port: imap.port,
      security: "plain",
      user: Redacted.make("intake@example.com"),
      password: Redacted.make("imap-secret-0123456789"),
      folder: "INBOX",
    },
    connectDeadline ? { connectDeadline } : {},
  );
  // Flipped after the layer, so a connect that fails is the error too.
  const failing = Effect.runPromise(
    Mailbox.use(operation).pipe(Effect.provide(layer), Effect.flip),
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
  expect(error.reason).toBe("refused");
  expect(imap.commands.some((line) => /^\S+ UID MOVE 1 /.test(line))).toBe(true);
});

test("a search the server refuses fails naming the server's reason", async () => {
  const { imap, error } = await failureOn({ refuseSearch: true }, (mailbox) =>
    mailbox.moveMessageId("<quota@shop.example>", "processed"),
  );
  expect(error.message).toBe(
    `127.0.0.1:${imap.port}, folder INBOX: moving mail to hex/processed failed: the server refused the search: [CANNOT] Search is not available right now`,
  );
  expect(error.reason).toBe("refused");
});

test("a connection the server drops ends the wait for news, saying the connection closed", async () => {
  const { imap, error } = await failureOn({ dropOn: "IDLE" }, (mailbox) =>
    mailbox.waitForChange(60_000),
  );
  expect(error.message).toStartWith(
    `127.0.0.1:${imap.port}, folder INBOX: waiting for new mail failed: the connection closed (read ECONNRESET)`,
  );
  expect(error.reason).toBe("connection-lost");
});

test("a connection dropped during a move says the connection closed, not that it was refused", async () => {
  const { imap, error } = await failureOn({ dropOn: "UID MOVE" }, (mailbox) =>
    mailbox.moveMessageId("<quota@shop.example>", "processed"),
  );
  expect(error.message).toStartWith(
    `127.0.0.1:${imap.port}, folder INBOX: moving mail to hex/processed failed: the connection closed`,
  );
  expect(error.reason).toBe("connection-lost");
});

test("a UID from a listing the folder's UIDVALIDITY changed since is stale, not a lost connection", async () => {
  const { error } = await failureOn({ uidValidities: [7, 8], dropOn: "FETCH" }, (mailbox) =>
    Effect.gen(function* () {
      expect(yield* mailbox.list).toEqual([{ uid: 1, messageId: "quota@shop.example" }]);
      // The connection dropped after the listing: the next one finds the UIDs renumbered.
      // A fetch that still met the old connection finds it lost; the one after reconnects.
      const first = yield* Effect.result(mailbox.source(1));
      if (first._tag === "Failure" && first.failure.reason !== "connection-lost") {
        return yield* Effect.fail(first.failure);
      }
      return yield* mailbox.source(1);
    }),
  );
  expect(error.message).toContain("the folder's UIDs changed since it was listed (UIDVALIDITY)");
  expect(error.reason).toBe("listing-stale");
});

test.each(["LOGIN", "SELECT"] as const)(
  "a server that never answers %s fails the connect deadline, and the attempt is closed",
  async (silentOn) => {
    const { imap, error } = await failureOn(
      { silentOn },
      (mailbox) => mailbox.list,
      Duration.millis(200),
    );
    expect(error.message).toBe(
      `127.0.0.1:${imap.port}, folder INBOX: connecting did not finish within 200ms`,
    );
    expect(error.reason).toBe("connection-lost");
    await within(imap.closed, "the attempt's connection to close", 2000);
  },
);
