import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { LibSQLStore } from "@mastra/libsql";

/**
 * LibSQL store on a local file. The argument is always treated as a filesystem path (a
 * `libsql://…` string becomes a file of that name), so this never connects to a remote database.
 * The file's directory is created if missing.
 */
export async function createLocalStore(databasePath: string) {
  await mkdir(dirname(databasePath), { recursive: true });
  return new LibSQLStore({ id: "hex-local", url: pathToFileURL(databasePath).href });
}
