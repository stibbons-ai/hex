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

/** A Filing as recorded per branch: whether it fell back is always known. */
export type RecordedFiling = Filing & { readonly fellBack: boolean };

/**
 * The branches of an Intake that succeeded so far, recorded as each succeeded, also while the
 * Intake is not processed yet (a run that failed in another branch).
 */
export interface IntakeBranches {
  readonly forwardings: readonly Forwarding[];
  /** By Document index. */
  readonly filings: readonly RecordedFiling[];
}

/** An Intake's failed runs: how many, and when the last one failed (ISO 8601 instant). */
export interface FailedRuns {
  readonly count: number;
  readonly lastFailedAt: string;
}

/**
 * A run's failure as recorded: the Intake's failed runs that count now, and whether this run is
 * the one the Intake failed permanently on (see `endFailedRuns`).
 */
export interface RecordedFailedRun {
  readonly count: number;
  readonly ended: boolean;
}

/** The ledger could not be read or written. */
export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Which Intakes are processed, keyed by normalised Message-ID (`normalizeMessageId`), so each is
 * processed once, which of an Intake's branches (a Forwarding per target, a Filing per Document)
 * succeeded, so a retry repeats only the others, and how many of its runs failed, so it fails
 * permanently after a number of them.
 */
export class IntakeLedger extends Context.Service<
  IntakeLedger,
  {
    /** The entry for this Message-ID, or undefined when the Intake was not processed yet. */
    readonly find: (messageId: string) => Effect.Effect<LedgerEntry | undefined, LedgerError>;
    /**
     * Records the Intake as processed now with its Filings, one per Document (so its Document
     * count is their number). Recording it again keeps the first record (a run resumed after a
     * restart repeats this).
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
      filing: RecordedFiling,
    ) => Effect.Effect<void, LedgerError>;
    /**
     * The Intake's failed runs that count: those since it last failed permanently (or ever); how
     * many, and when the last one failed; undefined when there are none.
     */
    readonly failedRuns: (messageId: string) => Effect.Effect<FailedRuns | undefined, LedgerError>;
    /**
     * Records that the run `runId` of the Intake failed now, and returns the failed runs that
     * count. Recording a run again keeps the first record, so a run repeated after a restart
     * counts once, and still says whether it was the one the Intake failed permanently on.
     */
    readonly recordFailedRun: (
      messageId: string,
      runId: string,
    ) => Effect.Effect<RecordedFailedRun, LedgerError>;
    /**
     * The Intake failed permanently, on the run `runId` if given: its failed runs stop counting,
     * so it gets its full number of runs again. `runId`'s own row stays, marked ended, so a repeat
     * of that run's step still sees the Intake failed permanently; without a run none stays. One
     * transaction: either all of it happens or nothing does.
     */
    readonly endFailedRuns: (
      messageId: string,
      runId?: string | undefined,
    ) => Effect.Effect<void, LedgerError>;
  }
>()("hex/IntakeLedger") {}

/**
 * Own tables in Mastra's LibSQL database, keyed by `message_id`: one row per processed Intake,
 * one per succeeded branch (a Forwarding per target, a Filing per Document), written as each
 * succeeds, and one per failed run of an Intake, kept after a later success and removed when the
 * Intake fails permanently (but for the row of the run it failed on, marked `ended`, if there is
 * one). A row is never replaced:
 * `ON CONFLICT DO NOTHING` keeps the first.
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
  `CREATE TABLE IF NOT EXISTS hex_intake_failed_runs (
  message_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, run_id)
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

const FailedRunRows = Schema.Array(
  Schema.Struct({ count: Schema.Int, last_failed_at: Schema.NullOr(Schema.String) }),
);
const decodeFailedRunRows = Schema.decodeUnknownEffect(FailedRunRows);

const RecordedFailedRunRows = Schema.Array(
  Schema.Struct({ count: Schema.Int, ended: Schema.Literals([0, 1]) }),
);
const decodeRecordedFailedRunRows = Schema.decodeUnknownEffect(RecordedFailedRunRows);

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

/** How long a ledger statement waits for a lock on `mastra.db` before failing with SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5000;

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
            // Mastra writes to the same file: wait up to 5 s for its locks instead of failing, on
            // every connection of the client's pool (a PRAGMA would cover only the first).
            const client = createClient({
              url: await localDatabaseUrl(databasePath),
              timeout: BUSY_TIMEOUT_MS,
            });
            try {
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

      const forwardingsOf = (id: string) =>
        execute(
          "SELECT target, forwarded_at FROM hex_intake_forwardings WHERE message_id = ? ORDER BY target",
          [id],
          "reading",
        ).pipe(
          Effect.flatMap(({ rows }) =>
            decodeForwardingRows(rows).pipe(
              Effect.mapError(ledgerError(`unreadable Forwardings for ${id}`)),
            ),
          ),
          Effect.map((rows) =>
            rows.map((row) => ({ target: row.target, forwardedAt: row.forwarded_at })),
          ),
        );
      const filingsOf = (id: string) =>
        execute(
          "SELECT document_index, path, fell_back FROM hex_intake_filings WHERE message_id = ? ORDER BY document_index",
          [id],
          "reading",
        ).pipe(
          Effect.flatMap(({ rows }) =>
            decodeFilingRows(rows).pipe(
              Effect.mapError(ledgerError(`unreadable Filings for ${id}`)),
            ),
          ),
          Effect.map((rows) =>
            rows.map((row) => ({
              index: row.document_index,
              path: row.path,
              fellBack: row.fell_back === 1,
            })),
          ),
        );
      const failedRunsOf = (id: string) =>
        execute(
          "SELECT COUNT(*) AS count, MAX(failed_at) AS last_failed_at FROM hex_intake_failed_runs WHERE message_id = ? AND ended = 0",
          [id],
          "reading",
        ).pipe(
          Effect.flatMap(({ rows }) =>
            decodeFailedRunRows(rows).pipe(
              Effect.mapError(ledgerError(`unreadable failed runs for ${id}`)),
            ),
          ),
          Effect.map(([row]): FailedRuns | undefined =>
            row && row.last_failed_at !== null
              ? { count: row.count, lastFailedAt: row.last_failed_at }
              : undefined,
          ),
        );

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
            const forwardings = yield* forwardingsOf(id);
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
              "INSERT INTO hex_intake_ledger (message_id, processed_at, document_count, filings) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
              [id, yield* now, filings.length, JSON.stringify(filings)],
              `recording ${id}`,
            );
          }),
        branches: (messageId) =>
          key(messageId).pipe(
            Effect.flatMap((id) =>
              Effect.all({ forwardings: forwardingsOf(id), filings: filingsOf(id) }),
            ),
          ),
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
        failedRuns: (messageId) => key(messageId).pipe(Effect.flatMap(failedRunsOf)),
        recordFailedRun: (messageId, runId) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            yield* execute(
              "INSERT INTO hex_intake_failed_runs (message_id, run_id, failed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
              [id, runId, yield* now],
              `recording the failed run ${runId} of ${id}`,
            );
            const { rows } = yield* execute(
              "SELECT (SELECT COUNT(*) FROM hex_intake_failed_runs WHERE message_id = ? AND ended = 0) AS count, ended FROM hex_intake_failed_runs WHERE message_id = ? AND run_id = ?",
              [id, id, runId],
              "reading",
            );
            const [row] = yield* decodeRecordedFailedRunRows(rows).pipe(
              Effect.mapError(ledgerError(`unreadable failed runs for ${id}`)),
            );
            if (!row)
              return yield* new LedgerError({ message: `failed run ${runId} not recorded` });
            return { count: row.count, ended: row.ended === 1 };
          }),
        endFailedRuns: (messageId, runId) =>
          Effect.gen(function* () {
            const id = yield* key(messageId);
            // Ended first, so even statement by statement no state left between them counts.
            yield* Effect.tryPromise({
              try: () =>
                client.batch(
                  [
                    {
                      sql: "UPDATE hex_intake_failed_runs SET ended = 1 WHERE message_id = ?",
                      args: [id],
                    },
                    {
                      sql: "DELETE FROM hex_intake_failed_runs WHERE message_id = ? AND run_id IS NOT ?",
                      args: [id, runId ?? null],
                    },
                  ],
                  "write",
                ),
              catch: ledgerError(`ending the failed runs of ${id}`),
            });
          }),
      };
    }),
  );
}
