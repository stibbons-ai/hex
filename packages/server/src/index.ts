import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLocalStore } from "@hex/adapters";
import { Mastra } from "@mastra/core/mastra";
import { type HonoBindings, type HonoVariables, MastraServer } from "@mastra/hono";
import { Hono } from "hono";

/** Only local clients reach the server; exposing it is a deployment decision, not a default. */
export const HOSTNAME = "127.0.0.1";

export interface ServerOptions {
  /** LibSQL database file; its directory is created if missing. */
  databasePath: string;
  /** TCP port; 0 picks a free one. */
  port: number;
}

export interface RunningServer {
  url: URL;
  /** Stops accepting requests, shuts Mastra down and closes storage. */
  stop(): Promise<void>;
}

/** Our own Bun.serve entrypoint with Mastra's routes mounted through the Hono adapter (ADR 0002). */
export async function startServer({ databasePath, port }: ServerOptions): Promise<RunningServer> {
  await mkdir(dirname(databasePath), { recursive: true });
  const storage = createLocalStore(databasePath);
  try {
    await storage.init();
    const mastra = new Mastra({ storage, logger: false });
    const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
    app.get("/health", (c) => c.json({ status: "ok" }));
    await new MastraServer({ app, mastra }).init();

    const server = Bun.serve({ hostname: HOSTNAME, port, fetch: app.fetch });
    return {
      url: server.url,
      async stop() {
        try {
          await server.stop();
          await mastra.shutdown();
        } finally {
          await storage.close();
        }
      },
    };
  } catch (error) {
    await storage.close();
    throw error;
  }
}
