import { normalizeMessageId } from "@hex/domain";
import { createClient } from "@libsql/client";
import type { InArgs } from "@libsql/client";
import { Clock, Context, Data, Effect, Layer, Schema } from "effect";
import { messageOf } from "./errors";
import { localDatabaseUrl } from "./storage";

/**
 * One Document's Filing: which attachment it was, where it landed, relative to the Outbox, and
 * whether it was filed by the received date because it had no usable Document date.
 */
export const Filing = Schema.Struct({
  /** The Document's 0-based index among the Intake's attachments. */
  index: Schema.Int,
  path: Schema.String,
  /**
   * True: filed by the received date (`FilingPlan.fellBack`), because the model answered no usable
   * Document date or hex never sent the Document to a model (a HEIC, HEIF, TIFF or BMP image, or
   * content that isn't a valid PDF or JPEG/PNG/GIF/WebP image). Absent on entries recorded before
   * #7, which filed every Document by the received date.
   */
  fellBack: Schema.optionalKey(Schema.Boolean),
});
export type Filing = typeof Filing.Type;

/** One target an Intake's Documents were forwarded to, and when (ISO 8601 instant). */
export interface Forwarding {
  readonly target: string;
  readonly forwardedAt: string;
}

/** What the ledger knows about one processed Intake. */
export interface LedgerEntry {
  readonly messageId: string;
  /** ISO 8601 instant. */
  readonly processedAt: string;
  readonly documentCount: number;
  readonly filings: readonly Filing[];
  /** The targets its Documents were forwarded to; none for Intakes processed before #8. */
  readonly forwardings: readonly Forwarding[];
}

/**
 * The branches of an Intake that succeeded so far, recorded as each succeeded, also while the
 * Intake is not processed yet (a run that failed in another branch).
 */
export interface IntakeBranches {
  readonly forwardings: readonly Forwarding[];
  /** By Document index. */
  readonly filings: readonly (Filing & { readonly fellBack: boolean })[];
}

/** The ledger could not be read or written. */
export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Which Intakes are processed, keyed by normalised Message-ID (`normalizeMessageId`), so each is
 * processed once, and which of an Intake's branches (a Forwarding per target, a Filing per
 * Document) succeeded, so a retry repeats only the others.
 */
export class IntakeLedger extends Context.Service<
  IntakeLedger,
  {
    /** The entry for this Message-ID, or undefined when the Intake was not processed yet. */
    readonly find: (messageId: string) => Effect.Effect<LedgerEntry | undefined, LedgerError>;
    /**
     * Records the Intake as processed now with its Filings, one per Document (so its Document
     * count is their number). Fails when it is already recorded (processed by someone else
     * meanwhile).
     */
    readonly record: (
      messageId: string,
      filings: readonly Filing[],
    ) => Effect.Effect<void, LedgerError>;
    /** The Intake's branches recorded so far, processed or not. */
    readonly branches: (messageId: string) => Effect.Effect<IntakeBranches, LedgerError>;
    /**
     * Records that the Intake's Documents were forwarded to `target` now. Recording a target
     * again keeps the first record (and its time).
     */
    readonly recordForwarding: (
      messageId: string,
      target: string,
    ) => Effect.Effect<void, LedgerError>;
    /**
     * Records one Document's Filing. Recording a Document (by index) again keeps the first
     * record: a Document is filed once.
     */
    readonly recordFiling: (
      messageId: string,
      filing: Filing & { readonly fellBack: boolean },
    ) => Effect.Effect<void, LedgerError>;
  }
>()("hex/IntakeLedger") {}

/**
 * Own tables in Mastra's LibSQL database, keyed by `message_id`: one row per processed Intake,
 * and one per succeeded branch (a Forwarding per target, a Filing per Document), written as each
 * succeeds. A branch row is never replaced: `ON CONFLICT DO NOTHING` keeps the first.
 */
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS hex_intake_ledger (
  message_id TEXT PRIMARY KEY NOT NULL,
  processed_at TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  filings TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS hex_intake_forwardings (
  message_id TEXT NOT NULL,
  target TEXT NOT NULL,
  forwarded_at TEXT NOT NULL,
  PRIMARY KEY (message_id, target)
)`,
  `CREATE TABLE IF NOT EXISTS hex_intake_filings (
  message_id TEXT NOT NULL,
  document_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  fell_back INTEGER NOT NULL,
  filed_at TEXT NOT NULL,
  PRIMARY KEY (message_id, document_index)
)`,
];

const Row = Schema.Struct({
  message_id: Schema.String,
  processed_at: Schema.String,
  document_count: Schema.Number,
  filings: Schema.fromJsonString(Schema.Array(Filing)),
});
const decodeRow = Schema.decodeUnknownEffect(Row);

const ForwardingRows = Schema.Array(
  Schema.Struct({ target: Schema.String, forwarded_at: Schema.String }),
);
const decodeForwardingRows = Schema.decodeUnknownEffect(ForwardingRows);

const FilingRows = Schema.Array(
  Schema.Struct({
    document_index: Schema.Int,
    path: Schema.String,
    fell_back: Schema.Literals([0, 1]),
  }),
);
const decodeFilingRows = Schema.decodeUnknownEffect(FilingRows);

/** The key of a Message-ID, failing for a blank one. */
function key(messageId: string): Effect.Effect<string, LedgerError> {
  const normalized = normalizeMessageId(messageId);
  return normalized
    ? Effect.succeed(normalized)
    : Effect.fail(new LedgerError({ message: "blank Message-ID" }));
}

const ledgerError = (what: string) => (cause: unknown) =>
  new LedgerError({ message: `Intake ledger: ${what}: ${messageOf(cause)}`, cause });

/** Now, as the ISO 8601 instant the ledger stores. */
const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

/**
 * The Intake ledger in the LibSQL file at `databasePath` (Mastra's `mastra.db`; its directory is
 * created if missing), on its own connection, closed when the layer is released. The tables are
 * created if missing.
 */
export function intakeLedgerLayer(databasePath: string): Layer.Layer<IntakeLedger, LedgerError> {
  return Layer.effect(
    IntakeLedger,
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const client = createClient({ url: await localDatabaseUrl(databasePath) });
            try {
              // Mastra writes to the same file; wait for its locks instead of failing.
              await client.execute("PRAGMA busy_timeout = 5000");
              for (const statement of CREATE_TABLES) await client.execute(statement);
            } catch (error) {
              client.close();
              throw error;
            }
            return client;
          },
          catch: ledgerError(`opening ${databasePath}`),
        }),
        (client) => Effect.sync(() => client.close()),
      );
      const execute = (sql: string, args: InArgs, what: string) =>
        Effect.tryPromise({ try: () => client.execute({ sql, args }), catch: ledgerError(what) });

      const branches = (id: string) =>
        Effect.gen(function* () {
          const forwardings = yield* execute(
            "SELECT target, forwarded_at FROM hex_intake_forwardings WHERE message_id = ? ORDER BY target",
            [id],
            "reading",
          ).pipe(
            Effect.flatMap(({ rows }) => decodeForwardingRows(rows)),
            Effect.mapError(ledgerError(`unreadable Forwardings for ${id}`)),
          );
          const filings = yield* execute(
            "SELECT document_index, path, fell_back FROM hex_intake_filings WHERE message_id = ? ORDER BY document_index",
            [id],
            "reading",
          ).pipe(
            Effect.flatMap(({ rows }) => decodeFilingRows(rows)),
            Effect.mapError(ledgerError(`unreadable Filings for ${id}`)),
          );
          return {
            forwardings: forwardings.map((row) => ({
              target: row.target,
              forwardedAt: row.forwarded_at,
            })),
            filings: filings.map((row) => ({
              index: row.document_index,
              path: row.path,
              fellBack: row.fell_back === 1,
            })),
          };
        });

      return {
        find: (messageId) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            const { rows } = yield* execute(
              "SELECT * FROM hex_intake_ledger WHERE message_id = ?",
              [id],
              "reading",
            );
            if (rows.length === 0) return undefined;
            const row = yield* decodeRow(rows[0]).pipe(
              Effect.mapError(ledgerError(`unreadable entry for ${id}`)),
            );
            const { forwardings } = yield* branches(id);
            return {
              messageId: row.message_id,
              processedAt: row.processed_at,
              documentCount: row.document_count,
              filings: row.filings,
              forwardings,
            };
          }),
        record: (messageId, filings) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            yield* execute(
              "INSERT INTO hex_intake_ledger (message_id, processed_at, document_count, filings) VALUES (?, ?, ?, ?)",
              [id, yield* now, filings.length, JSON.stringify(filings)],
              `recording ${id}`,
            );
          }),
        branches: (messageId) => key(messageId).pipe(Effect.flatMap(branches)),
        recordForwarding: (messageId, target) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            yield* execute(
              "INSERT INTO hex_intake_forwardings (message_id, target, forwarded_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
              [id, target, yield* now],
              `recording the Forwarding of ${id} to ${target}`,
            );
          }),
        recordFiling: (messageId, { index, path, fellBack }) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            yield* execute(
              "INSERT INTO hex_intake_filings (message_id, document_index, path, fell_back, filed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
              [id, index, path, fellBack ? 1 : 0, yield* now],
              `recording the Filing of Document ${index} of ${id}`,
            );
          }),
      };
    }),
  );
}
