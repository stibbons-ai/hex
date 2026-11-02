import { join, resolve } from "node:path";
import { startServer } from "./index";

const DEFAULT_PORT = 4111;

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`HEX_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

const server = await startServer({
  // The data directory: HEX_DATA_DIR, else ./.data (git-ignored); empty counts as unset.
  databasePath: join(resolve(process.env.HEX_DATA_DIR || ".data"), "mastra.db"),
  port: parsePort(process.env.HEX_PORT),
});
console.log(`hex listening on ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
