import { resolve } from "node:path";
import { startServer } from "./index";

const DEFAULT_PORT = 4111;

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new Error(`HEX_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

const server = await startServer({
  // HEX_DATA_DIR, else .data, relative to the working directory; empty counts as unset.
  databasePath: resolve(process.env.HEX_DATA_DIR || ".data", "mastra.db"),
  port: parsePort(process.env.HEX_PORT),
});
console.log(`hex listening on ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("hex: shutdown failed", error);
        process.exit(1);
      },
    );
  });
}
