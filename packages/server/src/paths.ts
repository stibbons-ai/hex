import { join, resolve } from "node:path";
import type { Env } from "./config";

/** Where hex keeps its state, absolute. */
export interface DataPaths {
  /** The LibSQL database shared by Mastra and the Intake ledger. */
  databasePath: string;
  /** The DuckDB database holding Mastra's observability data: traces, logs and metrics. */
  observabilityPath: string;
  outboxDirectory: string;
}

/**
 * The data directory `HEX_DATA_DIR` (default `.data`) holding the LibSQL database `mastra.db` and
 * the DuckDB database `observability.duckdb`, and the Outbox `HEX_OUTBOX_DIR` (default
 * `<data dir>/outbox`), relative to `base` (default: the working directory). Empty counts as unset.
 */
export function dataPaths(env: Env, base = process.cwd()): DataPaths {
  const dataDirectory = resolve(base, env["HEX_DATA_DIR"] || ".data");
  return {
    databasePath: join(dataDirectory, "mastra.db"),
    observabilityPath: join(dataDirectory, "observability.duckdb"),
    outboxDirectory: resolve(base, env["HEX_OUTBOX_DIR"] || join(dataDirectory, "outbox")),
  };
}
