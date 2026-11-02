import { resolve } from "node:path";
import { startServer } from "./index";
import { shutdownOnce } from "./lifecycle";

const DEFAULT_PORT = 4111;

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new Error(`HEX_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

const starting = startServer({
  // HEX_DATA_DIR, else .data, relative to the working directory; empty counts as unset.
  databasePath: resolve(process.env.HEX_DATA_DIR || ".data", "mastra.db"),
  port: parsePort(process.env.HEX_PORT),
});
// Registered before startup finishes, so an early signal still shuts down cleanly.
const shutdown = shutdownOnce(starting, {
  exit: (code) => process.exit(code),
  error: (message, cause) => console.error(message, cause),
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const server = await starting;
console.log(`hex listening on ${server.url}`);
