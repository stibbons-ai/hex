import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { LibSQLStore } from "@mastra/libsql";

/**
 * The `file:` URL of a local LibSQL database, its directory created if missing. The argument is
 * always treated as a filesystem path, so this never names a remote database: `libsql://host/x`
 * resolves to the file `<cwd>/libsql:/host/x`.
 */
export async function localDatabaseUrl(databasePath: string): Promise<string> {
  await mkdir(dirname(databasePath), { recursive: true });
  return pathToFileURL(databasePath).href;
}

/** LibSQL store on a local file (see {@link localDatabaseUrl}). */
export async function createLocalStore(databasePath: string) {
  return new LibSQLStore({ id: "hex-local", url: await localDatabaseUrl(databasePath) });
}
