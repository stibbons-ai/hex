import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { LibSQLStore } from "@mastra/libsql";

/**
 * LibSQL store on a local file. The argument is always treated as a filesystem path, so this
 * never connects to a remote database: `libsql://host/x` resolves to the file
 * `<cwd>/libsql:/host/x`.
 * The file's directory is created if missing.
 */
export async function createLocalStore(databasePath: string) {
  await mkdir(dirname(databasePath), { recursive: true });
  return new LibSQLStore({ id: "hex-local", url: pathToFileURL(databasePath).href });
}
