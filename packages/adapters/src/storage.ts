import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LibSQLStore } from "@mastra/libsql";

/**
 * The data directory: `HEX_DATA_DIR`, else `./.data` (git-ignored).
 * An empty value counts as unset.
 */
export function resolveDataDirectory(env: Record<string, string | undefined> = process.env) {
  return resolve(env.HEX_DATA_DIR || ".data");
}

/** Mastra's LibSQL database file inside the data directory. */
export function mastraDatabasePath(dataDirectory: string) {
  return join(dataDirectory, "mastra.db");
}

/** A filesystem path, never a remote database URL, keeps storage local. */
export function createLocalStore(databasePath: string) {
  return new LibSQLStore({ id: "hex-local", url: pathToFileURL(resolve(databasePath)).href });
}
