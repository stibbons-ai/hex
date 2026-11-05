import { join, resolve } from "node:path";
import type { Env } from "./config";

/** Where hex keeps its state, absolute. */
export interface DataPaths {
  /** The LibSQL database shared by Mastra and the Intake ledger. */
  databasePath: string;
  outboxDirectory: string;
}

/**
 * The data directory `HEX_DATA_DIR` (default `.data`) holding the LibSQL database `mastra.db`, and
 * the Outbox `HEX_OUTBOX_DIR` (default `<data dir>/outbox`), relative to the working directory.
 * Empty counts as unset.
 */
export function dataPaths(env: Env): DataPaths {
  const dataDirectory = resolve(env["HEX_DATA_DIR"] || ".data");
  return {
    databasePath: join(dataDirectory, "mastra.db"),
    outboxDirectory: resolve(env["HEX_OUTBOX_DIR"] || join(dataDirectory, "outbox")),
  };
}
