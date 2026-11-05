import { resolve } from "node:path";
import type { Env } from "./config";

/**
 * Where hex keeps its state, relative to the working directory: the data directory
 * `HEX_DATA_DIR` (default `.data`) holding the LibSQL database `mastra.db`, and the Outbox
 * `HEX_OUTBOX_DIR` (default `<data dir>/outbox`). Empty counts as unset.
 */
export function dataPaths(env: Env): { databasePath: string; outboxDirectory: string } {
  const dataDirectory = resolve(env["HEX_DATA_DIR"] || ".data");
  return {
    databasePath: resolve(dataDirectory, "mastra.db"),
    outboxDirectory: resolve(env["HEX_OUTBOX_DIR"] || resolve(dataDirectory, "outbox")),
  };
}
