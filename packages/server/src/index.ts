import { createLocalStore } from "@hex/adapters";
import type { IMastraLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { ORPCError, onError, onSuccess } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { createChatAgent, disconnectAdapters } from "./chat";
import type { ChatOptions } from "./chat";
import { closeInOrder } from "./close";
import { allowedHosts } from "./hosts";
import { router } from "./router";

export { contract } from "./contract";
export type { ChatOptions } from "./chat";

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
  /**
   * Mastra's logger, which also logs server faults in requests (not caller errors); omitted keeps
   * Mastra's default. `false` silences it (tests only).
   */
  logger?: IMastraLogger | false;
  /** Workflows to register with Mastra. */
  workflows?: Record<string, AnyWorkflow>;
  /** How long stop() lets in-flight requests and open streams finish before closing them. */
  stopGraceMs?: number;
  /**
   * The chat agent and its channels; omitted runs without chat. The server owns the adapters: it
   * connects them on start and disconnects them in stop() or after a failed start.
   */
  chat?: ChatOptions;
}

const DEFAULT_STOP_GRACE_MS = 5000;

export interface RunningServer {
  url: URL;
  /** The address Bun.serve bound to. */
  hostname: string;
  mastra: Mastra;
  /**
   * Disconnects the chat channels (no new messages), stops accepting requests and gives in-flight
   * ones (open streams included) `stopGraceMs` before closing them, then shuts Mastra down (which
   * closes the store) and closes the store again as a fallback. Each step runs even if an earlier
   * one fails. LibSQL's file handles may stay open until GC.
   */
  stop(): Promise<void>;
}

/**
 * Our own Bun.serve entrypoint: `GET`/`HEAD /health` plus the oRPC API under /rpc (ADR 0004), both
 * behind the Host allow-list, and the chat channels when configured. Channels connect out (Slack
 * socket mode); no webhook route is served. Startup fails, with everything closed again, when a
 * channel fails to connect.
 */
export async function startServer({
  databasePath,
  port,
  logger,
  workflows,
  stopGraceMs = DEFAULT_STOP_GRACE_MS,
  chat,
}: ServerOptions): Promise<RunningServer> {
  const storage = await createLocalStore(databasePath);
  try {
    await storage.init();
    const agent = chat ? createChatAgent(chat) : undefined;
    const mastra = new Mastra({
      storage,
      ...(logger === undefined ? {} : { logger }),
      ...(workflows ? { workflows } : {}),
      ...(agent ? { agents: { [agent.id]: agent } } : {}),
    });
    // Mastra starts the channels without awaiting them and only logs a failure; awaiting the same
    // start here makes a channel that can't connect fail startup.
    await agent?.getChannels()?.initialize(mastra);
    // Server faults only: client errors such as NOT_FOUND are the caller's to handle.
    const logFault = (error: unknown) => {
      if (error instanceof ORPCError && error.status < 500) return;
      mastra.getLogger().error("hex: oRPC call failed", error);
    };
    // Per-request contexts whose procedure returned. The handler-level interceptor also sees a
    // caller's malformed body failing to decode, before the procedure; after it, a failure is in
    // encoding our output, so ours.
    const procedureReturned = new WeakSet<object>();
    const handler = new RPCHandler(router, {
      clientInterceptors: [
        onError(logFault),
        onSuccess((_output, { context }) => {
          procedureReturned.add(context);
        }),
      ],
      interceptors: [
        onError((error, { context }) => {
          if (procedureReturned.has(context)) logFault(error);
        }),
      ],
    });
    // The bound port is known only after Bun.serve, so the check reads the set per request.
    let hosts = new Set<string>();
    const server = Bun.serve({
      hostname: HOSTNAME,
      port,
      async fetch(request) {
        if (!hosts.has(request.headers.get("host") ?? "")) {
          return new Response("Forbidden host", { status: 403 });
        }
        const isGetOrHead = request.method === "GET" || request.method === "HEAD";
        if (isGetOrHead && new URL(request.url).pathname === "/health") {
          return Response.json({ status: "ok" });
        }
        // A fresh context per request: procedureReturned is keyed by it.
        const { matched, response } = await handler.handle(request, {
          prefix: "/rpc",
          context: { mastra },
        });
        return matched ? response : new Response("Not found", { status: 404 });
      },
      // Anything thrown outside oRPC's own error handling, e.g. oRPC's fetch adapter failing to
      // stringify the encoded body: logged, and answered without Bun's debug page.
      error(error) {
        mastra.getLogger().error("hex: request failed", error);
        return new Response("Internal server error", { status: 500 });
      },
    });
    hosts = allowedHosts(server.port ?? port);
    return {
      url: server.url,
      hostname: server.hostname ?? "",
      mastra,
      stop: () =>
        closeInOrder([
          async () => {
            if (chat) await disconnectAdapters(chat.adapters);
          },
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
    // Keep the startup error; a failure to close what was half-built is only logged.
    if (chat) {
      await disconnectAdapters(chat.adapters).catch((closeError: unknown) => {
        console.error(
          "hex: disconnecting chat channels after a failed start also failed",
          closeError,
        );
      });
    }
    await storage.close().catch((closeError: unknown) => {
      console.error("hex: closing storage after a failed start also failed", closeError);
    });
    throw error;
  }
}
