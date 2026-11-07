// The Mastra wiring shared by hex's server (`startServer`) and Mastra Studio (`studio/index.ts`),
// which `mastra build` bundles for Node: no Bun-only APIs here.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLocalStore } from "@hex/adapters";
import type { Agent } from "@mastra/core/agent";
import { MastraBaseError } from "@mastra/core/error";
import { ConsoleLogger, LogLevel, isAdaptableLogger } from "@mastra/core/logger";
import type { AdaptableLogger, IMastraLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import type { MastraRecoveryConfig } from "@mastra/core/mastra";
import { MastraCompositeStore } from "@mastra/core/storage";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { DuckDBStore } from "@mastra/duckdb";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { closeInOrder } from "./close";
import { FailedRunError, INTAKE_WORKFLOW_ID } from "./intake-workflow";
import type { DataPaths } from "./paths";

/**
 * hex's Mastra storage: the LibSQL store for every domain (memory, workflow state, ...) except
 * observability, which lives in the DuckDB file. close() closes both files: the composite only
 * forwards to its LibSQL parent, since the DuckDB domain has no close() of its own. Its private
 * field keeps any other store (a plain LibSQL one, say) from passing for it.
 */
class HexStore extends MastraCompositeStore {
  readonly #duckdb: DuckDBStore;

  constructor(libsql: MastraCompositeStore, duckdb: DuckDBStore) {
    super({ id: "hex", default: libsql, domains: { observability: duckdb.observability } });
    this.#duckdb = duckdb;
  }

  override async close(): Promise<void> {
    await closeInOrder([() => super.close(), () => this.#duckdb.close()]);
  }
}

export type { HexStore };

/**
 * The store on the local files at `paths`, their directories created if missing. LibSQL opens its
 * file here, DuckDB on first use (`init()`) and then holds the file's lock, which only one process
 * can hold.
 */
export async function createHexStore({
  databasePath,
  observabilityPath,
}: Pick<DataPaths, "databasePath" | "observabilityPath">): Promise<HexStore> {
  // First: a failure here leaves no LibSQL handle open.
  await mkdir(dirname(observabilityPath), { recursive: true });
  const libsql = await createLocalStore(databasePath);
  return new HexStore(
    libsql,
    new DuckDBStore({ id: "hex-observability", path: observabilityPath }),
  );
}

export interface HexMastraOptions {
  storage: HexStore;
  /**
   * Mastra's logger; omitted, a copy of Mastra's default (see {@link mastraDefaultLogger}), passed
   * as hex's own, so a file-system routed `logger.ts` would not replace it. Either way without the
   * line Mastra logs for the expected error of a failed Intake run the mailbox watcher follows
   * (see {@link withoutFailedRunErrors}). A logger at ERROR level hides hex's failed-run warning
   * while that line stays dropped, so such a failed run then logs nothing.
   * `false` silences it (tests only).
   */
  logger?: IMastraLogger | false | undefined;
  workflows?: Record<string, AnyWorkflow> | undefined;
  agents?: Record<string, Agent> | undefined;
  /** Mastra's boot-time recovery, which only a Mastra deployer (Studio's `mastra start`) runs. */
  recovery?: MastraRecoveryConfig | undefined;
}

/**
 * hex's Mastra on `storage`, tracing every agent and workflow run into the store's observability
 * domain (the DuckDB file) and nowhere else: the storage exporter is the only exporter.
 */
export function createHexMastra({
  storage,
  logger,
  workflows,
  agents,
  recovery,
}: HexMastraOptions): Mastra {
  return new Mastra({
    storage,
    observability: new Observability({
      configs: { hex: { serviceName: "hex", exporters: [new MastraStorageExporter()] } },
    }),
    logger: logger === false ? false : withoutFailedRunErrors(logger ?? mastraDefaultLogger()),
    ...(workflows ? { workflows } : {}),
    ...(agents ? { agents } : {}),
    ...(recovery ? { recovery } : {}),
  });
}

/** The logger Mastra (`@mastra/core` 1.80.0) creates when given none. */
function mastraDefaultLogger(): IMastraLogger {
  const production = process.env.NODE_ENV === "production" && process.env.MASTRA_DEV !== "true";
  return new ConsoleLogger({ name: "Mastra", level: production ? LogLevel.WARN : LogLevel.INFO });
}

/**
 * The line Mastra logs at error level, with the stack, for the step error it tracks as
 * `exception`, when that error is the {@link FailedRunError} the Intake workflow ends a failed run
 * with on purpose.
 */
function failedRunLine(exception: Error): string | undefined {
  if (!(exception instanceof MastraBaseError)) return undefined;
  const { cause, details } = exception;
  return cause instanceof FailedRunError &&
    details?.workflowId === INTAKE_WORKFLOW_ID &&
    typeof details.stepId === "string"
    ? `Error executing step ${details.stepId}: ${cause.stack}`
    : undefined;
}

/**
 * `logger`, less what Mastra logs for a failed Intake run's {@link FailedRunError}: an error line
 * with its stack, which reads like a crash, for an outcome the mailbox watcher, which follows the
 * run, logs itself ("the run failed" warning). Mastra tracks a failing step's error, as the cause
 * of the exception, right before it logs that line: that exception is kept from `logger`, and
 * the next error line dropped if it is exactly the one Mastra logs for it. Both are kept from the
 * observability log records too (the error line's export, the tracked exception); the step's
 * span keeps its error. Everything else goes to `logger` as is, its children too (Mastra's
 * components log through `child()`). An adaptable `logger` (as `ConsoleLogger`) keeps its trace
 * correlation and observability export, which Mastra attaches through the wrapper; any other
 * Mastra wraps in its DualLogger, which still exports what the wrapper drops, so there the
 * suppression is console-only.
 */
function withoutFailedRunErrors(logger: IMastraLogger): IMastraLogger {
  /** The error line to drop next, for the failed run's exception just tracked. */
  let expected: string | undefined;
  const quiet: Partial<AdaptableLogger> &
    IMastraLogger & { child?: (...args: unknown[]) => IMastraLogger } = {
    debug: (message, ...args) => logger.debug(message, ...args),
    info: (message, ...args) => logger.info(message, ...args),
    warn: (message, ...args) => logger.warn(message, ...args),
    error: (message, ...args) => {
      const dropped = args.length === 0 && message === expected;
      expected = undefined;
      if (!dropped) logger.error(message, ...args);
    },
    trackException: (exception, metadata) => {
      expected = failedRunLine(exception);
      if (expected === undefined) logger.trackException(exception, metadata);
    },
    getTransports: () => logger.getTransports(),
    listLogs: (transportId, params) => logger.listLogs(transportId, params),
    listLogsByRunId: (args) => logger.listLogsByRunId(args),
  };
  const { child } = logger as { child?: (...args: unknown[]) => IMastraLogger };
  if (typeof child === "function") {
    quiet.child = (...args) => withoutFailedRunErrors(child.apply(logger, args));
  }
  if (isAdaptableLogger(logger)) {
    quiet.__attachObservability = (context) => logger.__attachObservability(context);
    // The same logger wired to a second Mastra still warns, wrapped or not.
    quiet.__observabilityAttachmentKey = () => logger.__observabilityAttachmentKey?.() ?? logger;
  }
  return quiet;
}
