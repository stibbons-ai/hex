import { createLocalStore } from "@hex/adapters";
import type { IMastraLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { type HonoBindings, type HonoVariables, MastraServer } from "@mastra/hono";
import { Hono } from "hono";
import { closeInOrder } from "./close";
import { allowedHosts } from "./hosts";

/**
 * Loopback only: other machines can't connect. Local browsers still can, so requests are also
 * held to a loopback Host header (DNS rebinding).
 */
const HOSTNAME = "127.0.0.1";

export interface ServerOptions {
  /** LibSQL database file; its directory is created if missing. */
  databasePath: string;
  /** TCP port; 0 picks a free one. */
  port: number;
  /** Mastra's logger; omitted keeps Mastra's default. `false` silences it (tests only). */
  logger?: IMastraLogger | false;
  /** Workflows to register with Mastra. */
  workflows?: Record<string, AnyWorkflow>;
  /** How long stop() lets in-flight requests and open streams finish before closing them. */
  stopGraceMs?: number;
}

const DEFAULT_STOP_GRACE_MS = 5000;

export interface RunningServer {
  url: URL;
  /** The address Bun.serve bound to. */
  hostname: string;
  mastra: Mastra;
  /**
   * Stops accepting requests and gives in-flight ones (open streams included) `stopGraceMs` before
   * closing them, then shuts Mastra down (which closes the store) and closes the store again as a
   * fallback. Each step runs even if an earlier one fails. LibSQL's file handles may stay open
   * until GC.
   */
  stop(): Promise<void>;
}

/** Our own Bun.serve entrypoint with Mastra's routes mounted through the Hono adapter (ADR 0002). */
export async function startServer({
  databasePath,
  port,
  logger,
  workflows,
  stopGraceMs = DEFAULT_STOP_GRACE_MS,
}: ServerOptions): Promise<RunningServer> {
  const storage = await createLocalStore(databasePath);
  try {
    await storage.init();
    const mastra = new Mastra({
      storage,
      ...(logger === undefined ? {} : { logger }),
      ...(workflows ? { workflows } : {}),
    });
    const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
    // The bound port is known only after Bun.serve, so the check reads the set per request.
    let hosts = new Set<string>();
    app.use("*", async (c, next) => {
      if (!hosts.has(c.req.header("host") ?? "")) return c.text("Forbidden host", 403);
      await next();
    });
    app.get("/health", (c) => c.json({ status: "ok" }));
    await new MastraServer({ app, mastra }).init();

    const server = Bun.serve({ hostname: HOSTNAME, port, fetch: app.fetch });
    hosts = allowedHosts(server.port ?? port);
    return {
      url: server.url,
      hostname: server.hostname ?? "",
      mastra,
      stop: () =>
        closeInOrder([
          async () => {
            // Graceful stop never resolves while a client holds a stream open, so bound it.
            const grace = Promise.withResolvers<void>();
            const timer = setTimeout(grace.resolve, stopGraceMs);
            await Promise.race([server.stop(), grace.promise]);
            clearTimeout(timer);
            await server.stop(true);
          },
          () => mastra.shutdown(),
          () => storage.close(),
        ]),
    };
  } catch (error) {
    // Keep the startup error; a failure to close the half-built store is only logged.
    await storage.close().catch((closeError: unknown) => {
      console.error("hex: closing storage after a failed start also failed", closeError);
    });
    throw error;
  }
}
