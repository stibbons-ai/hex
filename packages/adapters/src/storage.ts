import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { LibSQLStore } from "@mastra/libsql";

/**
 * A filesystem path, never a remote database URL, keeps storage local.
 * The file's directory is created if missing.
 */
export async function createLocalStore(databasePath: string) {
  await mkdir(dirname(databasePath), { recursive: true });
  return new LibSQLStore({ id: "hex-local", url: pathToFileURL(databasePath).href });
}
