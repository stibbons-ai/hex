import { normalizeMessageId } from "@hex/domain";
import { createClient } from "@libsql/client";
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
   * Document date or the Document is a type hex doesn't send to a model (HEIC, HEIF, TIFF, BMP).
   * Absent on entries recorded before Document dates were read: nothing is known either way.
   */
  fellBack: Schema.optionalKey(Schema.Boolean),
});
export type Filing = typeof Filing.Type;

/** What the ledger knows about one processed Intake. */
export interface LedgerEntry {
  readonly messageId: string;
  /** ISO 8601 instant. */
  readonly processedAt: string;
  readonly documentCount: number;
  readonly filings: readonly Filing[];
}

/** The ledger could not be read or written. */
export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Which Intakes are processed, keyed by normalised Message-ID (`normalizeMessageId`), so each is
 * processed once.
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
  }
>()("hex/IntakeLedger") {}

/**
 * Own table in Mastra's LibSQL database. Per-branch outcomes (Forwarding per target, Filing per
 * Document with retries) can come as further `hex_intake_*` tables keyed by `message_id`.
 */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS hex_intake_ledger (
  message_id TEXT PRIMARY KEY NOT NULL,
  processed_at TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  filings TEXT NOT NULL
)`;

const Row = Schema.Struct({
  message_id: Schema.String,
  processed_at: Schema.String,
  document_count: Schema.Number,
  filings: Schema.fromJsonString(Schema.Array(Filing)),
});
const decodeRow = Schema.decodeUnknownEffect(Row);

/** The key of a Message-ID, failing for a blank one. */
function key(messageId: string): Effect.Effect<string, LedgerError> {
  const normalized = normalizeMessageId(messageId);
  return normalized
    ? Effect.succeed(normalized)
    : Effect.fail(new LedgerError({ message: "blank Message-ID" }));
}

const ledgerError = (what: string) => (cause: unknown) =>
  new LedgerError({ message: `Intake ledger: ${what}: ${messageOf(cause)}`, cause });

/**
 * The Intake ledger in the LibSQL file at `databasePath` (Mastra's `mastra.db`; its directory is
 * created if missing), on its own connection, closed when the layer is released. The table is
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
              await client.execute(CREATE_TABLE);
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
      return {
        find: (messageId) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            const { rows } = yield* Effect.tryPromise({
              try: () =>
                client.execute({
                  sql: "SELECT * FROM hex_intake_ledger WHERE message_id = ?",
                  args: [id],
                }),
              catch: ledgerError("reading"),
            });
            if (rows.length === 0) return undefined;
            const row = yield* decodeRow(rows[0]).pipe(
              Effect.mapError(ledgerError(`unreadable entry for ${id}`)),
            );
            return {
              messageId: row.message_id,
              processedAt: row.processed_at,
              documentCount: row.document_count,
              filings: row.filings,
            };
          }),
        record: (messageId, filings) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.tryPromise({
              try: () =>
                client.execute({
                  sql: "INSERT INTO hex_intake_ledger (message_id, processed_at, document_count, filings) VALUES (?, ?, ?, ?)",
                  args: [id, new Date(now).toISOString(), filings.length, JSON.stringify(filings)],
                }),
              catch: ledgerError(`recording ${id}`),
            });
          }),
      };
    }),
  );
}
