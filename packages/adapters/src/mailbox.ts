import { normalizeMessageId } from "@hex/domain";
import { Context, Data, Duration, Effect, Layer, Redacted, Schema } from "effect";
import { ImapFlow } from "imapflow";
import type { ImapFlowError } from "imapflow";
import { credentialRedactions, excerpt, messageOf, redact } from "./errors";
import { LOOPBACK_ONLY, plaintextRefused } from "./mailer";
import type { SmtpSettings } from "./mailer";

/** Where an Intake's mail goes once its outcome is known: processed, or failed permanently. */
export const MailOutcome = Schema.Literals(["processed", "failed"]);
export type MailOutcome = typeof MailOutcome.Type;

/** The outcome folder's path parts, joined with the server's hierarchy delimiter (`hex.processed`). */
const OUTCOME_FOLDERS: Record<MailOutcome, readonly [string, string]> = {
  processed: ["hex", "processed"],
  failed: ["hex", "failed"],
};

/** The outcome folder as Daniel reads it, `hex/processed` or `hex/failed`, whatever the delimiter. */
export const outcomeFolder = (outcome: MailOutcome) => OUTCOME_FOLDERS[outcome].join("/");

/** One mail waiting in the watched folder: its UID, and its Message-ID (normalised) if it has one. */
export interface WaitingMail {
  readonly uid: number;
  /** As the server reads the header (its ENVELOPE), which may differ from hex's own reading. */
  readonly messageId: string | undefined;
}

/**
 * A mailbox operation failed. The message names the server, the folder and the IMAP stage, never
 * the credentials or a mail's content. `reason`:
 * - `connection-lost`: the connection is gone (or never came up), so every operation fails until
 *   it is back;
 * - `listing-stale`: the folder's UIDs changed meaning since the last listing (UIDVALIDITY), so
 *   every UID from it is useless;
 * - `refused`: the server refused this one operation.
 */
export class MailboxError extends Data.TaggedError("MailboxError")<{
  readonly message: string;
  readonly reason: "refused" | "connection-lost" | "listing-stale";
}> {}

/** Thrown when the folder's UIDs changed meaning since the last listing. */
class StaleListing extends Error {}

/**
 * The intake mailbox: the watched folder hex takes its Intakes from, and the outcome folders it
 * moves them to with IMAP MOVE. hex never sets or reads a mail's flags.
 *
 * A UID is only meaningful against the last {@link list}: one caller (the mailbox watcher) lists
 * and then works through that listing; the Mailbox checks the folder's UIDVALIDITY against it.
 */
export class Mailbox extends Context.Service<
  Mailbox,
  {
    /** The watched folder, as configured. */
    readonly folder: string;
    /** Every mail in the watched folder, in the folder's order, read or not. */
    readonly list: Effect.Effect<readonly WaitingMail[], MailboxError>;
    /**
     * The raw RFC 822 bytes of the mail at `uid` of the last {@link list}, undefined when it is
     * gone. Fails when the folder's UIDs changed meaning since that listing (UIDVALIDITY).
     */
    readonly source: (uid: number) => Effect.Effect<Uint8Array | undefined, MailboxError>;
    /**
     * Waits until new mail may have arrived in the watched folder (the server said so, IMAP IDLE)
     * or `timeout` passed, whichever comes first. Fails when the connection is lost.
     */
    readonly waitForChange: (timeout: Duration.Input) => Effect.Effect<void, MailboxError>;
    /**
     * Moves every mail in the watched folder with this Message-ID (compared normalised, see
     * `normalizeMessageId`, against the server's reading) to the outcome's folder, creating it if
     * missing; how many it moved.
     */
    readonly moveMessageId: (
      messageId: string,
      to: MailOutcome,
    ) => Effect.Effect<number, MailboxError>;
    /**
     * Moves the mail at `uid` of the last {@link list} to the outcome's folder; whether it was
     * still there. Fails like {@link source} when UIDs changed meaning.
     */
    readonly moveUid: (uid: number, to: MailOutcome) => Effect.Effect<boolean, MailboxError>;
    /** Closes the connection for good: every later operation fails. */
    readonly close: Effect.Effect<void>;
  }
>()("hex/Mailbox") {}

/**
 * Where and as whom hex reads the intake mailbox, secured as SMTP is (`tls` being implicit TLS on
 * port 993 here), and which folder it watches.
 */
export interface ImapSettings extends SmtpSettings {
  readonly folder: string;
}

/** The stage an error from opening a connection failed in, recorded where it was thrown. */
const openingStages = new WeakMap<object, string>();

/** How long connecting, logging in and opening the folder may take before the attempt fails. */
const CONNECT_DEADLINE = Duration.seconds(60);
/** How long closing waits for the server's answer to LOGOUT before dropping the connection. */
const LOGOUT_DEADLINE = Duration.seconds(5);
/**
 * How long the server may stay silent. While IDLE, the client then probes the connection with a
 * NOOP, and no answer within as long again counts as a lost connection: a half-open connection
 * (a NAT dropping it while IDLE) is noticed after about 3 min, not after imapflow's default 5 min
 * (10 while IDLE). A command left unanswered that long (a fetch, a MOVE, a slow SEARCH) counts as
 * a lost connection at once.
 */
const SOCKET_TIMEOUT_MS = 90_000;

/** The server's reason for refusing a command, `[CODE] text`, if it gave one. */
function refusalOf(error: ImapFlowError | undefined): string {
  if (!error) return "";
  const { serverResponseCode, responseText } = error;
  const reason = [serverResponseCode && `[${serverResponseCode}]`, responseText]
    .filter(Boolean)
    .join(" ");
  return reason ? `: ${reason}` : "";
}

/**
 * The Mailbox on an IMAP server over one connection, opened when the layer is built (so wrong
 * credentials, an unreachable server, a server without IMAP MOVE (RFC 6851) or a missing folder
 * fail it, within `connectDeadline`, default 60 s) and opened again on the next operation after
 * it was lost. Mail is moved with MOVE only, never emulated with COPY, `\Deleted` and EXPUNGE,
 * which would set flags and could expunge other mail. The watched folder stays selected; the
 * server's new-mail notifications come through IMAP IDLE, which the client enters after 1 s
 * without a command (imapflow's default, 15 s, would leave mail arriving right after a look
 * unnoticed that long). While IDLE, a server silent for 90 s gets a NOOP, and no answer within
 * another 90 s counts as a lost connection; a command unanswered for 90 s counts as lost at once.
 * Mail is fetched with `BODY.PEEK`, so reading never marks it seen. Closed when the layer is
 * released.
 */
export function imapMailboxLayer(
  settings: ImapSettings,
  { connectDeadline = CONNECT_DEADLINE }: { readonly connectDeadline?: Duration.Duration } = {},
): Layer.Layer<Mailbox, MailboxError> {
  return Layer.effect(
    Mailbox,
    Effect.acquireRelease(
      Effect.sync(() => new ImapConnection(settings)).pipe(
        Effect.tap((connection) =>
          connection
            .run("connecting", () => connection.open())
            .pipe(
              Effect.timeoutOrElse({
                duration: connectDeadline,
                orElse: () =>
                  Effect.fail(
                    new MailboxError({
                      message: `${settings.host}:${settings.port}, folder ${settings.folder}: connecting did not finish within ${Duration.format(connectDeadline)}`,
                      reason: "connection-lost",
                    }),
                  ),
              }),
              // A failed attempt (the deadline among others) closes the connection, whatever
              // stage it hangs in, connecting, logging in or opening the folder.
              Effect.onError(() => connection.close),
            ),
        ),
      ),
      (connection) => connection.close,
    ).pipe(
      Effect.map((connection) =>
        Mailbox.of({
          folder: settings.folder,
          list: connection.run("listing", () => connection.list()),
          source: (uid) => connection.run("fetching a mail", () => connection.source(uid)),
          waitForChange: (timeout) =>
            connection
              .run("waiting for new mail", (signal) => connection.waitForChange(signal))
              .pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.void })),
          moveMessageId: (messageId, to) =>
            connection.run(`moving mail to ${outcomeFolder(to)}`, () =>
              connection.moveMessageId(messageId, to),
            ),
          moveUid: (uid, to) =>
            connection.run(`moving mail to ${outcomeFolder(to)}`, () =>
              connection.moveUid(uid, to),
            ),
          close: connection.close,
        }),
      ),
    ),
  );
}

/** The IMAP connection behind {@link imapMailboxLayer}, reopened on demand after a loss. */
class ImapConnection {
  readonly #settings: ImapSettings;
  /** What an error must never show: the credentials, as LOGIN and AUTHENTICATE PLAIN send them. */
  readonly #secrets: readonly (readonly [string, string])[];
  #client: ImapFlow | undefined;
  #opening: Promise<ImapFlow> | undefined;
  #closed = false;
  /** The UIDVALIDITY the last listing's UIDs belong to. */
  #listedValidity: bigint | undefined;
  /** New mail arrived since the last listing, so a wait for it ends at once. */
  #changed = false;
  /** Waits for new mail, each ended (with a reason when the connection is gone) by `#wake`. */
  readonly #waiters = new Set<(lost?: Error) => void>();
  /** Outcome folders known to exist on the current connection. */
  #outcomeFolders = new Set<MailOutcome>();
  /**
   * The error of the last command imapflow logged as failed. For MOVE and SEARCH, which it
   * answers with `false` instead of throwing, this is the only way to name the server's reason
   * for a refusal; `#notDone` tells a refusal from a lost connection.
   */
  #refused: ImapFlowError | undefined;
  /** The client until it is open (connected, logged in, folder selected), so closing ends it. */
  #connecting: ImapFlow | undefined;

  constructor(settings: ImapSettings) {
    this.#settings = settings;
    const user = Redacted.value(settings.user);
    const password = Redacted.value(settings.password);
    // LOGIN sends the password quoted, `\` and `"` escaped.
    this.#secrets = credentialRedactions(user, password, [
      password.replace(/[\\"]/g, "\\$&"),
      password,
    ]);
  }

  /**
   * `operation` as an Effect: a failure becomes a MailboxError naming the server, the folder and
   * `stage`, its message without the credentials and cut short, and saying whether the connection
   * is gone. The signal aborts on interruption.
   */
  run<A>(stage: string, operation: (signal: AbortSignal) => Promise<A>) {
    const { host, port, folder } = this.#settings;
    return Effect.tryPromise({
      try: operation,
      catch: (cause) => {
        const { code, authenticationFailed, responseText } = (cause ?? {}) as ImapFlowError;
        const opening = cause instanceof Object ? openingStages.get(cause) : undefined;
        const failedStage = authenticationFailed ? "logging in" : (opening ?? stage);
        const detail = [messageOf(cause), responseText].filter(Boolean).join(": ");
        return new MailboxError({
          message: `${host}:${port}, folder ${folder}: ${failedStage} failed${code ? ` (${code})` : ""}: ${excerpt(redact(detail, this.#secrets))}`,
          reason:
            cause instanceof StaleListing
              ? "listing-stale"
              : this.#closed || !this.#client?.usable
                ? "connection-lost"
                : "refused",
        });
      },
    });
  }

  /** The connected client with the watched folder selected, connecting first if needed. */
  open(): Promise<ImapFlow> {
    if (this.#closed) return Promise.reject(new Error("the mailbox is closed"));
    if (this.#client?.usable) return Promise.resolve(this.#client);
    this.#opening ??= this.#connect().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  async #connect(): Promise<ImapFlow> {
    const { host, port, security, user, password, folder } = this.#settings;
    const refuse = (stage: string, message: string) => {
      const refused = new Error(message);
      openingStages.set(refused, stage);
      return refused;
    };
    if (plaintextRefused(security, host)) {
      throw refuse("connecting", `plaintext IMAP is only allowed to ${LOOPBACK_ONLY}`);
    }
    const client = new ImapFlow({
      host,
      port,
      secure: security === "tls",
      // Required for starttls: never log in over a connection the upgrade was stripped from.
      doSTARTTLS: security === "starttls",
      auth: { user: Redacted.value(user), pass: Redacted.value(password) },
      // Only to keep the reason of a refused command; nothing is written anywhere.
      logger: {
        debug: () => {},
        info: () => {},
        warn: (entry: { err?: ImapFlowError }) => {
          if (entry?.err) this.#refused = entry.err;
        },
        error: () => {},
      },
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: SOCKET_TIMEOUT_MS,
      autoIdleDelay: 1000,
    });
    /** Why the connection ended, if it ended with an error. */
    let failure: Error | undefined;
    // Emitted at most once, the connection closing after it.
    client.on("error", (error) => {
      failure = error;
    });
    client.on("exists", ({ count, prevCount }) => {
      if (count > prevCount) this.#wake();
    });
    client.on("close", () => {
      if (this.#client === client) this.#client = undefined;
      this.#wake(new Error(`the connection closed${failure ? ` (${messageOf(failure)})` : ""}`));
    });
    const failedAt = (stage: string) => (error: unknown) => {
      if (error instanceof Object) openingStages.set(error, stage);
      client.close();
      throw error;
    };
    this.#connecting = client;
    try {
      await client.connect().catch(failedAt("connecting"));
      if (!client.capabilities.has("MOVE")) {
        client.close();
        throw refuse(
          "checking the server",
          "the server lacks the IMAP MOVE extension (RFC 6851), which hex requires to move mail without setting flags",
        );
      }
      await client.mailboxOpen(folder).catch(failedAt("opening the folder"));
    } finally {
      this.#connecting = undefined;
    }
    if (this.#closed) {
      client.close();
      throw new Error("the mailbox is closed");
    }
    this.#client = client;
    this.#outcomeFolders = new Set();
    return client;
  }

  /** Ends every wait: as a change, or failing it with `lost`. */
  #wake(lost?: Error) {
    if (!lost) this.#changed = true;
    for (const waiter of this.#waiters) waiter(lost);
    this.#waiters.clear();
  }

  /** Runs `operation` holding the watched folder's lock, so no other command interleaves. */
  async #locked<A>(operation: (client: ImapFlow) => Promise<A>): Promise<A> {
    const client = await this.open();
    const lock = await client.getMailboxLock(this.#settings.folder);
    try {
      return await operation(client);
    } finally {
      lock.release();
    }
  }

  /** Fails when the folder's UIDs no longer mean what they meant at the last listing. */
  #checkValidity(client: ImapFlow) {
    if (!client.mailbox || client.mailbox.uidValidity !== this.#listedValidity) {
      throw new StaleListing("the folder's UIDs changed since it was listed (UIDVALIDITY)");
    }
  }

  list(): Promise<WaitingMail[]> {
    return this.#locked(async (client) => {
      this.#changed = false;
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error("the folder is not selected");
      this.#listedValidity = mailbox.uidValidity;
      if (mailbox.exists === 0) return [];
      const mails = await client.fetchAll("1:*", { uid: true, envelope: true });
      return mails.map(({ uid, envelope }) => ({
        uid,
        messageId: normalizeMessageId(envelope?.messageId ?? "") || undefined,
      }));
    });
  }

  source(uid: number): Promise<Uint8Array | undefined> {
    return this.#locked(async (client) => {
      this.#checkValidity(client);
      const mail = await client.fetchOne(String(uid), { source: true }, { uid: true });
      // A Buffer, so a Uint8Array as is: no copy of the whole mail.
      return mail ? mail.source : undefined;
    });
  }

  async waitForChange(signal: AbortSignal): Promise<void> {
    const client = await this.open();
    if (this.#changed || !client.usable) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = (lost?: Error) => {
      signal.removeEventListener("abort", stop);
      if (lost) reject(lost);
      else resolve();
    };
    const stop = () => {
      this.#waiters.delete(waiter);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
    this.#waiters.add(waiter);
    return promise;
  }

  /** Creates the outcome folder unless it exists; once per connection. */
  async #ensureFolder(client: ImapFlow, outcome: MailOutcome) {
    if (this.#outcomeFolders.has(outcome)) return;
    const path = [...OUTCOME_FOLDERS[outcome]];
    try {
      await client.mailboxCreate(path);
    } catch (error) {
      // A server without RFC 5530's ALREADYEXISTS: an existing folder answers STATUS.
      if ((await client.status(path, { messages: true }).catch(() => false)) === false) {
        throw error;
      }
    }
    this.#outcomeFolders.add(outcome);
  }

  /** The error for a command imapflow answered with `false`: refused, or the connection gone. */
  #notDone(client: ImapFlow, command: string): Error {
    return new Error(
      client.usable
        ? `the server refused the ${command}${redact(refusalOf(this.#refused), this.#secrets)}`
        : "the connection closed",
    );
  }

  async #move(client: ImapFlow, uids: number[], outcome: MailOutcome) {
    await this.#ensureFolder(client, outcome);
    this.#refused = undefined;
    const moved = await client.messageMove(uids, [...OUTCOME_FOLDERS[outcome]], { uid: true });
    if (!moved) throw this.#notDone(client, "move");
  }

  moveMessageId(messageId: string, outcome: MailOutcome): Promise<number> {
    const id = normalizeMessageId(messageId);
    return this.#locked(async (client) => {
      if (!id) return 0;
      // SEARCH HEADER matches substrings; the envelope says which candidate is this Message-ID.
      this.#refused = undefined;
      const candidates = await client.search({ header: { "message-id": id } }, { uid: true });
      if (!candidates) throw this.#notDone(client, "search");
      if (candidates.length === 0) return 0;
      const mails = await client.fetchAll(candidates, { uid: true, envelope: true }, { uid: true });
      const uids = mails
        .filter(({ envelope }) => normalizeMessageId(envelope?.messageId ?? "") === id)
        .map(({ uid }) => uid);
      if (uids.length > 0) await this.#move(client, uids, outcome);
      return uids.length;
    });
  }

  moveUid(uid: number, outcome: MailOutcome): Promise<boolean> {
    return this.#locked(async (client) => {
      this.#checkValidity(client);
      // A UID MOVE of a mail no longer there succeeds on most servers: check it is there.
      const mail = await client.fetchOne(String(uid), { uid: true }, { uid: true });
      if (!mail) return false;
      await this.#move(client, [uid], outcome);
      return true;
    });
  }

  /** Closes for good: waits end, LOGOUT gets {@link LOGOUT_DEADLINE}, then the socket closes. */
  readonly close: Effect.Effect<void> = Effect.suspend(() => {
    this.#closed = true;
    this.#wake(new Error("the mailbox is closed"));
    this.#connecting?.close();
    const client = this.#client;
    this.#client = undefined;
    if (!client) return Effect.void;
    return Effect.tryPromise(() => client.logout()).pipe(
      Effect.timeout(LOGOUT_DEADLINE),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => client.close())),
    );
  });
}
