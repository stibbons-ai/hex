// The Mailbox for tests: folders of raw mails in memory, standing in for the IMAP server as the
// recording Mailer stands in for the SMTP one. Moves are recorded; connection loss and refused
// operations are scripted; new-mail notifications (IMAP IDLE) and poll intervals happen when the
// test says so.
import { Mailbox, MailboxError, outcomeFolder } from "@hex/adapters";
import type { MailOutcome } from "@hex/adapters";
import { normalizeMessageId } from "@hex/domain";
import type { Duration } from "effect";
import { Effect, Layer } from "effect";

interface StoredMail {
  readonly uid: number;
  readonly source: Uint8Array;
  /** The Message-ID as the server reads it (its ENVELOPE), normalised. */
  readonly serverMessageId: string | undefined;
}

/** One move the Mailbox made: the mail's Message-ID as the server reads it, and where it went. */
export interface RecordedMove {
  readonly messageId: string | undefined;
  readonly to: string;
}

/** The normalised Message-ID in a raw mail's header, if it has one, read as a server would. */
function messageIdOf(source: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(source);
  const header = text.slice(0, text.search(/\r?\n\r?\n/) >>> 0).replace(/\r?\n[ \t]+/g, " ");
  const match = /^message-id:(.*)$/im.exec(header);
  return (match && normalizeMessageId(match[1]!)) || undefined;
}

/**
 * An in-memory Mailbox watching `folder` (INBOX by default). `idle: false` is a server without
 * IMAP IDLE: delivered mail wakes no wait, only {@link tick} (the poll interval) does.
 */
export function memoryMailbox({ folder = "INBOX", idle = true } = {}) {
  const folders = new Map<string, StoredMail[]>([[folder, []]]);
  const moves: RecordedMove[] = [];
  /** Every operation attempted, in order, by name (`listing`, `moving mail to hex/processed`, …). */
  const operations: string[] = [];
  /** The timeout of every wait for news, in order. */
  const waits: Duration.Input[] = [];
  let nextUid = 1;
  let uidValidity = 1;
  let listedValidity: number | undefined;
  /** Operations that fail next, as a server that can't be reached. */
  let unreachable = 0;
  /** Operations the server refuses next, by name prefix, each with how many more times. */
  const refusals = new Map<string, number>();
  let closed = false;
  /** The folder gets a new UIDVALIDITY right after the next listing. */
  let renumberAfterListing = false;
  /** New mail since the last listing, so the next wait ends at once (with IDLE). */
  let changed = false;
  /** The watcher's pending wait, if it waits. */
  let waiter: ((outcome: Effect.Effect<void, MailboxError>) => void) | undefined;
  /** Who waits for the watcher to wait again. */
  let waitingListeners: (() => void)[] = [];
  /** Who waits for the next operation, attempted or failed. */
  let operationListeners: ((what: string) => void)[] = [];

  const failure = (what: string, reason: string, connectionLost: boolean) =>
    new MailboxError({
      message: `127.0.0.1:993, folder ${folder}: ${what} failed: ${reason}`,
      connectionLost,
    });
  /** Fails `what` while the server is unreachable, refuses it or is closed, else runs `run`. */
  const operation = <A>(what: string, run: () => A) =>
    Effect.suspend(() => {
      operations.push(what);
      for (const listener of operationListeners) listener(what);
      operationListeners = [];
      if (closed) {
        return Effect.fail(
          new MailboxError({ message: "the mailbox is closed", connectionLost: true }),
        );
      }
      if (unreachable > 0) {
        unreachable--;
        return Effect.fail(failure(what, "connection lost", true));
      }
      for (const [prefix, left] of refusals) {
        if (left > 0 && what.startsWith(prefix)) {
          refusals.set(prefix, left - 1);
          return Effect.fail(failure(what, "the server refused it: [NOPERM] not allowed", false));
        }
      }
      // `run` throws a MailboxError for a failure of its own (a changed UIDVALIDITY).
      return Effect.try({ try: run, catch: (error) => error as MailboxError });
    });
  const watched = () => folders.get(folder)!;
  const checkValidity = (what: string) => {
    if (listedValidity !== uidValidity) {
      throw new MailboxError({
        message: `127.0.0.1:993, folder ${folder}: ${what} failed: the folder's UIDs changed since it was listed (UIDVALIDITY)`,
        connectionLost: false,
        listingStale: true,
      });
    }
  };
  const moveOut = (mails: readonly StoredMail[], to: MailOutcome) => {
    const destination = outcomeFolder(to);
    const target = folders.get(destination) ?? [];
    folders.set(destination, target);
    folders.set(
      folder,
      watched().filter((mail) => !mails.includes(mail)),
    );
    for (const mail of mails) {
      target.push({ ...mail, uid: nextUid++ });
      moves.push({ messageId: mail.serverMessageId, to: destination });
    }
  };
  const renumber = () => {
    uidValidity++;
    folders.set(
      folder,
      watched().map((mail) => ({ ...mail, uid: nextUid++ })),
    );
  };
  const wake = (outcome: Effect.Effect<void, MailboxError>) => {
    const pending = waiter;
    waiter = undefined;
    pending?.(outcome);
  };

  const layer = Layer.succeed(Mailbox, {
    folder,
    list: operation("listing", () => {
      changed = false;
      listedValidity = uidValidity;
      const listed = watched().map(({ uid, serverMessageId }) => ({
        uid,
        messageId: serverMessageId,
      }));
      if (renumberAfterListing) {
        renumberAfterListing = false;
        renumber();
      }
      return listed;
    }),
    source: (uid) =>
      operation("fetching a mail", () => {
        checkValidity("fetching a mail");
        return watched().find((mail) => mail.uid === uid)?.source;
      }),
    waitForChange: (timeout) =>
      Effect.flatMap(
        operation("waiting for new mail", () => waits.push(timeout)),
        () =>
          Effect.callback<void, MailboxError>((resume) => {
            if (idle && changed) return resume(Effect.void);
            waiter = resume;
            for (const listener of waitingListeners) listener();
            waitingListeners = [];
            return Effect.sync(() => {
              if (waiter === resume) waiter = undefined;
            });
          }),
      ),
    // As the live Mailbox: matched against the server's reading of the Message-ID.
    moveMessageId: (messageId, to) =>
      operation(`moving mail to ${outcomeFolder(to)}`, () => {
        const id = normalizeMessageId(messageId);
        const copies = watched().filter(({ serverMessageId }) => id && serverMessageId === id);
        moveOut(copies, to);
        return copies.length;
      }),
    // Named apart from the move by Message-ID, so a test can refuse just this one.
    moveUid: (uid, to) =>
      operation(`moving mail to ${outcomeFolder(to)} by UID`, () => {
        checkValidity(`moving mail to ${outcomeFolder(to)} by UID`);
        const mails = watched().filter((mail) => mail.uid === uid);
        moveOut(mails, to);
        return mails.length > 0;
      }),
    close: Effect.sync(() => {
      closed = true;
      wake(
        Effect.fail(new MailboxError({ message: "the mailbox is closed", connectionLost: true })),
      );
    }),
  });

  return {
    layer,
    /** Every move, in order. */
    moves,
    operations,
    waits,
    /** Whether the Mailbox was closed. */
    get closed() {
      return closed;
    },
    /**
     * Puts a raw mail into the watched folder; with IDLE, a waiting watcher hears of it.
     * `serverMessageId`: the Message-ID the server reports, when it reads the header differently
     * from hex (a comment in it, an encoded word, two Message-ID headers).
     */
    deliver(source: Uint8Array, { serverMessageId = messageIdOf(source) } = {}) {
      watched().push({ uid: nextUid++, source, serverMessageId });
      if (idle) {
        changed = true;
        wake(Effect.void);
      }
    },
    /** The Message-IDs (as the server reads them) of the mails in `name`. */
    messageIds(name: string = folder): (string | undefined)[] {
      return (folders.get(name) ?? []).map(({ serverMessageId }) => serverMessageId);
    },
    /** Puts mail back from `from` into the watched folder, as Daniel moving it back would. */
    moveBack(from: string) {
      const mails = folders.get(from) ?? [];
      folders.set(from, []);
      for (const mail of mails) watched().push({ ...mail, uid: nextUid++ });
    },
    /** Gives the folder a new UIDVALIDITY: the UIDs of the last listing mean nothing any more. */
    renumber,
    /** Gives the folder a new UIDVALIDITY right after the next listing, before anything else. */
    renumberAfterNextListing() {
      renumberAfterListing = true;
    },
    /** The server refuses the next `times` operations whose name starts with `prefix`. */
    refuse(prefix: string, times = 1) {
      refusals.set(prefix, times);
    },
    /** The poll interval passed: a waiting watcher looks again. */
    tick() {
      wake(Effect.void);
    },
    /**
     * The connection drops: a wait fails, and so do the next `attempts` operations, each a
     * reconnect attempt that fails.
     */
    disconnect(attempts = 0) {
      unreachable = attempts;
      wake(Effect.fail(failure("waiting for new mail", "connection lost", true)));
    },
    /** Resolves once the watcher waits for a change, i.e. finished its scan; at once if it does. */
    waiting(): Promise<void> {
      if (waiter) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waitingListeners.push(resolve);
      return promise;
    },
    /** Resolves with the next operation's name (`moving mail to hex/processed`, …), even a failing one. */
    nextOperation(): Promise<string> {
      const { promise, resolve } = Promise.withResolvers<string>();
      operationListeners.push(resolve);
      return promise;
    },
  };
}
