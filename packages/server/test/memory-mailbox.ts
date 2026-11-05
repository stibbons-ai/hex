// The Mailbox for tests: folders of raw mails in memory, standing in for the IMAP server as the
// recording Mailer stands in for the SMTP one. Moves are recorded; connection loss is scripted;
// new-mail notifications (IMAP IDLE) and poll intervals happen when the test says so.
import { Mailbox, MailboxError, outcomeFolder } from "@hex/adapters";
import type { MailOutcome } from "@hex/adapters";
import { normalizeMessageId } from "@hex/domain";
import { Effect, Layer } from "effect";

interface StoredMail {
  readonly uid: number;
  readonly source: Uint8Array;
}

/** One move the Mailbox made: the mail's Message-ID (normalised, if any) and where it went. */
export interface RecordedMove {
  readonly messageId: string | undefined;
  readonly to: string;
}

/** The normalised Message-ID in a raw mail's header, if it has one. */
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
  let nextUid = 1;
  let uidValidity = 1;
  let listedValidity: number | undefined;
  /** Operations that fail next, as a server that can't be reached. */
  let unreachable = 0;
  let closed = false;
  /** New mail since the last listing, so the next wait ends at once (with IDLE). */
  let changed = false;
  /** The watcher's pending wait, if it waits. */
  let waiter: ((outcome: Effect.Effect<void, MailboxError>) => void) | undefined;
  /** Who waits for the watcher to wait again. */
  let waitingListeners: (() => void)[] = [];
  /** Who waits for the next operation, attempted or failed. */
  let operationListeners: ((what: string) => void)[] = [];

  const lost = (what: string) =>
    new MailboxError({
      message: `127.0.0.1:993, folder ${folder}: ${what} failed: connection lost`,
    });
  /** Fails `what` while the server is unreachable or closed, else runs `operation`. */
  const operation = <A>(what: string, run: () => A) =>
    Effect.suspend(() => {
      for (const listener of operationListeners) listener(what);
      operationListeners = [];
      if (closed) return Effect.fail(new MailboxError({ message: "the mailbox is closed" }));
      if (unreachable > 0) {
        unreachable--;
        return Effect.fail(lost(what));
      }
      // `run` throws a MailboxError for a failure of its own (a changed UIDVALIDITY).
      return Effect.try({ try: run, catch: (error) => error as MailboxError });
    });
  const watched = () => folders.get(folder)!;
  const checkValidity = (what: string) => {
    if (listedValidity !== uidValidity) {
      throw new MailboxError({
        message: `127.0.0.1:993, folder ${folder}: ${what} failed: the folder's UIDs changed since it was listed (UIDVALIDITY)`,
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
      target.push({ uid: nextUid++, source: mail.source });
      moves.push({ messageId: messageIdOf(mail.source), to: destination });
    }
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
      return watched().map(({ uid, source }) => ({ uid, messageId: messageIdOf(source) }));
    }),
    source: (uid) =>
      operation("fetching a mail", () => {
        checkValidity("fetching a mail");
        return watched().find((mail) => mail.uid === uid)?.source;
      }),
    waitForChange: () =>
      Effect.flatMap(
        operation("waiting for new mail", () => undefined),
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
    moveMessageId: (messageId, to) =>
      operation(`moving mail to ${outcomeFolder(to)}`, () => {
        const id = normalizeMessageId(messageId);
        const copies = watched().filter(({ source }) => id && messageIdOf(source) === id);
        moveOut(copies, to);
        return copies.length;
      }),
    moveUid: (uid, to) =>
      operation(`moving mail to ${outcomeFolder(to)}`, () => {
        checkValidity(`moving mail to ${outcomeFolder(to)}`);
        moveOut(
          watched().filter((mail) => mail.uid === uid),
          to,
        );
      }),
    close: Effect.sync(() => {
      closed = true;
      wake(Effect.fail(new MailboxError({ message: "the mailbox is closed" })));
    }),
  });

  return {
    layer,
    /** Every move, in order. */
    moves,
    /** Whether the Mailbox was closed. */
    get closed() {
      return closed;
    },
    /** Puts a raw mail into the watched folder; with IDLE, a waiting watcher hears of it. */
    deliver(source: Uint8Array) {
      watched().push({ uid: nextUid++, source });
      if (idle) {
        changed = true;
        wake(Effect.void);
      }
    },
    /** The Message-IDs (normalised) of the mails in `name`, `undefined` for a mail without one. */
    messageIds(name: string = folder): (string | undefined)[] {
      return (folders.get(name) ?? []).map(({ source }) => messageIdOf(source));
    },
    /** Puts mail back from `from` into the watched folder, as Daniel moving it back would. */
    moveBack(from: string) {
      const mails = folders.get(from) ?? [];
      folders.set(from, []);
      for (const { source } of mails) watched().push({ uid: nextUid++, source });
    },
    /** Gives the folder a new UIDVALIDITY: the UIDs of the last listing mean nothing any more. */
    renumber() {
      uidValidity++;
      folders.set(
        folder,
        watched().map(({ source }) => ({ uid: nextUid++, source })),
      );
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
      wake(Effect.fail(lost("waiting for new mail")));
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
