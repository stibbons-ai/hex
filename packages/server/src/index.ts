import { isIP } from "node:net";
import type { IMastraLogger } from "@mastra/core/logger";
import type { Mastra } from "@mastra/core/mastra";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { ORPCError, onError, onSuccess } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { createChatAgent } from "./chat";
import type { ChatAgent, ChatOptions } from "./chat";
import { chatStores } from "./chat-state";
import { closeInOrder } from "./close";
import { isCyclicOrTooDeep } from "./cyclic";
import { createHexMastra, createHexStore } from "./mastra";
import { allowedHosts } from "./hosts";
import { DEFAULT_HOST } from "./listen-address";
import { INTAKE_WORKFLOW_ID } from "./intake-workflow";
import { watchMailbox } from "./mailbox-watcher";
import type { MailboxWatcherOptions } from "./mailbox-watcher";
import { router } from "./router";

export { contract } from "./contract";
export type { ChatOptions } from "./chat";
export { loadEvalConfig } from "./config";

export interface ServerOptions {
  /** LibSQL database file; its directory is created if missing. */
  databasePath: string;
  /**
   * DuckDB file for traces, logs and metrics; its directory is created if missing. One process at
   * a time can open it.
   */
  observabilityPath: string;
  /**
   * IP address to listen on, never a name; default 127.0.0.1, so other machines can't connect.
   * Local browsers still can, so requests are also held to a loopback Host header or the bound
   * address itself (DNS rebinding, see `allowedHosts`). The container image listens on 0.0.0.0
   * inside its own network namespace and is published on the host's loopback only (ADR 0005).
   */
  hostname?: string;
  /** TCP port; 0 picks a free one. */
  port: number;
  /**
   * Mastra's logger, which also logs server faults in requests (not caller errors); omitted or
   * `false` as `HexMastraOptions.logger` says.
   */
  logger?: IMastraLogger | false;
  /** Workflows to register with Mastra. */
  workflows?: Record<string, AnyWorkflow>;
  /**
   * How long stop() lets in-flight requests, open streams and chat replies finish before closing
   * them.
   */
  stopGraceMs?: number;
  /**
   * The chat agent and its channels; omitted runs without chat. The server owns the adapters: it
   * connects them on start and disconnects them in stop() or after a failed start.
   */
  chat?: ChatOptions;
  /** How long the chat channels get to connect before startup fails. */
  chatStartTimeoutMs?: number;
  /**
   * The intake mailbox to watch with the registered Intake workflow (see `watchMailbox`);
   * omitted runs without a watcher.
   */
  mailbox?: Pick<MailboxWatcherOptions, "runtime" | "pollMs"> | undefined;
}

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_CHAT_START_TIMEOUT_MS = 30_000;

/**
 * Whether `promise` settled within `ms`: true when it resolved in time, false on timeout; a
 * rejection in time is rethrown.
 */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => timeout.resolve(false), ms);
  try {
    return await Promise.race([promise.then(() => true), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunningServer {
  url: URL;
  /** The address Bun.serve bound to. */
  hostname: string;
  mastra: Mastra;
  /**
   * Settles once Mastra's boot sweep of the runs active in storage is done (run after the server
   * started): when the runs it could restart at once finished; a run whose previous process's
   * lease was still live is restarted later, by Mastra. The mailbox watcher, if any, starts
   * alongside the sweep. Never rejects: a failed sweep is logged.
   */
  booted: Promise<void>;
  /**
   * Stops the mailbox watcher (it takes no more mail and closes its connection). A run in
   * progress goes on, but Mastra's shutdown doesn't wait for it: closing the store and the
   * runtime, and the process exiting, cut it off, so it stays active in storage and resumes at
   * the next boot; one that finishes within the stop's grace can no longer move its mail, which
   * for a processed Intake the next boot's look moves. Then it
   * stops admitting chat messages and disconnects the channels (bounded by `stopGraceMs`), stops
   * accepting requests and gives in-flight ones (open streams and chat replies included), and a
   * channel disconnect still running, `stopGraceMs` more before closing them, then shuts Mastra
   * down and closes the store. Waiting for the disconnect lets a channel finish its own last
   * writes (Signal: its receive cursor, once its running replies are done) while the store is
   * open. Mastra closes the store before its final trace flush, which reopens the DuckDB file, so
   * the last close is what releases the file's lock. Each step runs even if an earlier one fails;
   * a step cut short is logged. LibSQL's file handles may stay open until GC.
   */
  stop(): Promise<void>;
}

/**
 * Our own Bun.serve entrypoint: `GET`/`HEAD /health` plus the oRPC API under /rpc (ADR 0004), both
 * behind the Host allow-list, and the chat channels when configured. Channels connect out (Slack
 * socket mode); no webhook route is served. Startup fails, with everything closed again, when a
 * channel doesn't start within `chatStartTimeoutMs`, fails to start, or starts but can't work (its
 * `verify` throws, e.g. Slack rejected the bot token). A start that finishes after the deadline
 * is disconnected again when the adapter allows it (Slack: only while it is still checking the
 * bot token); otherwise the caller is expected to exit, as `main.ts` does. Once serving, it
 * restarts the workflow runs a stopped or killed hex left active (hex has no Mastra deployer to
 * do it, ADR 0004) and starts the mailbox watcher, if any, alongside (see `booted`).
 */
export async function startServer({
  databasePath,
  observabilityPath,
  hostname = DEFAULT_HOST,
  port,
  logger,
  workflows,
  stopGraceMs = DEFAULT_STOP_GRACE_MS,
  chat,
  chatStartTimeoutMs = DEFAULT_CHAT_START_TIMEOUT_MS,
  mailbox,
}: ServerOptions): Promise<RunningServer> {
  // Before anything opens: a DNS name in the Host allow-list would let a page whose name resolves
  // here pass the DNS rebinding check.
  if (isIP(hostname) === 0) {
    throw new Error(
      `hex: the server listens on an IP address only, got ${JSON.stringify(hostname)}`,
    );
  }
  const storage = await createHexStore({ databasePath, observabilityPath });
  // Slack: closes the socket (and stops its reconnect loop). Every adapter is disconnected even
  // if another fails. Safe to run more than once.
  const disconnectChat = () =>
    closeInOrder(
      Object.values(chat?.channels ?? {}).map(
        ({ adapter }) =>
          async () =>
            adapter.disconnect?.(),
      ),
    );
  /**
   * `disconnectChat`, bounded by `stopGraceMs`: one that fails in time rejects; one that hangs is
   * logged and returned as `stillDisconnecting`, which settles with it but never rejects: a
   * failure after the bound is logged when it happens. `when` names the phase in the log lines.
   * Wrapped in an object: an async function returning the promise itself would wait for it.
   */
  const disconnectChatWithin = async (
    when: string,
    log: (message: string, cause?: unknown) => void,
  ): Promise<{ stillDisconnecting?: Promise<void> }> => {
    const disconnecting = disconnectChat();
    if (await settlesWithin(disconnecting, stopGraceMs)) return {};
    log(`hex: ${when}: chat channels did not disconnect within ${stopGraceMs} ms`);
    return {
      stillDisconnecting: disconnecting.catch((error: unknown) => {
        log(`hex: ${when}: disconnecting chat channels failed late`, error);
      }),
    };
  };
  let chatAgent: ChatAgent | undefined;
  try {
    await storage.init();
    chatAgent = chat ? createChatAgent(chat, await chatStores(storage)) : undefined;
    const mastra = createHexMastra({
      storage,
      logger,
      workflows,
      agents: chatAgent && { [chatAgent.agent.id]: chatAgent.agent },
    });
    // A watcher without the Intake workflow fails startup here.
    const watching: Omit<MailboxWatcherOptions, "log"> | undefined = mailbox && {
      ...mailbox,
      workflow: mastra.getWorkflow(INTAKE_WORKFLOW_ID),
    };
    if (chat && chatAgent) {
      // Mastra starts the channels without awaiting them and only logs a failure (so a failed
      // start is logged twice: by Mastra and as our startup error); awaiting the same start here
      // makes a channel that can't start fail startup. Starting covers Slack's bot-token check and
      // its socket connect, whose client retries some failures forever, hence the deadline.
      const starting = chatAgent.agent.getChannels()!.initialize(mastra);
      if (!(await settlesWithin(starting, chatStartTimeoutMs))) {
        // The start goes on in the background. Disconnecting once it settles (either way: with
        // several channels, one may have connected before another failed) catches a late finish
        // in Slack's bot-token check. It can't catch one inside the socket connect: the adapter
        // drops its socket client on disconnect, and @slack/socket-mode's start() doesn't re-check
        // `shuttingDown` after retrieveWSSURL, so that socket opens unowned until the process
        // exits.
        void starting.then(disconnectChat, disconnectChat).catch((error: unknown) => {
          console.error("hex: disconnecting chat channels after a late start failed", error);
        });
        throw new Error(`hex: chat channels did not start within ${chatStartTimeoutMs} ms`);
      }
      for (const [platform, { allowlist, verify }] of Object.entries(chat.channels)) {
        try {
          verify?.();
        } catch (error) {
          throw new Error(`chat channel "${platform}": ${(error as Error).message}`, {
            cause: error,
          });
        }
        if (allowlist.length === 0) {
          mastra
            .getLogger()
            .warn(`hex: chat channel "${platform}": empty allowlist, nobody will be answered`);
        }
      }
    }
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
        // A cyclic output fails like the procedure itself, logged once above, and never reaches
        // oRPC's encoder, which would find the cycle only by overflowing the stack.
        onSuccess((output, { context, path }) => {
          if (isCyclicOrTooDeep(output)) {
            throw new Error(`hex: the output of ${path.join(".")} is cyclic or too deep`);
          }
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
      hostname,
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
    hosts = allowedHosts(server.port ?? port, hostname);
    // The watcher starts alongside the sweep, so a run that hangs on resuming doesn't hold up all
    // intake. They never race for one Intake: a run to resume stays `running` in storage until it
    // ends, so the watcher skips its Intake (also while Mastra waits for a previous process's lease
    // to lapse before it re-checks the run).
    const watcher = watching && watchMailbox({ ...watching, log: mastra.getLogger() });
    const booted = mastra.restartAllActiveWorkflowRuns().catch((error: unknown) => {
      mastra
        .getLogger()
        .error("hex: restarting the active workflow runs failed; their Intakes wait", error);
    });
    return {
      url: server.url,
      hostname: server.hostname ?? "",
      mastra,
      booted,
      stop: () => {
        let stillDisconnecting: Promise<void> | undefined;
        return closeInOrder([
          async () => {
            if (watcher) await watcher.stop();
          },
          async () => {
            chatAgent?.close();
            ({ stillDisconnecting } = await disconnectChatWithin("stop", (message, cause) =>
              mastra.getLogger().warn(message, ...(cause === undefined ? [] : [cause])),
            ));
          },
          async () => {
            let drained = false;
            try {
              // Graceful stop never resolves while a client holds a stream open, so bound it.
              drained = await settlesWithin(
                Promise.all([
                  server.stop(),
                  chatAgent?.settled(),
                  stillDisconnecting?.then(() => {
                    stillDisconnecting = undefined;
                  }),
                ]),
                stopGraceMs,
              );
            } finally {
              if (!drained) {
                const cutOff = chatAgent?.pending() ?? 0;
                mastra
                  .getLogger()
                  .warn(
                    `hex: stop: requests and chat replies still running after ${stopGraceMs} ms were cut off` +
                      (cutOff > 0 ? ` (${cutOff} chat replies)` : "") +
                      (stillDisconnecting ? ", with the chat channels still disconnecting" : ""),
                  );
              }
              await server.stop(true);
            }
          },
          () => mastra.shutdown(),
          // Required, not a fallback: Mastra 1.80's shutdown() closes the store and then flushes
          // the last spans, reopening DuckDB; only this releases the file's lock.
          () => storage.close(),
        ]);
      },
    };
  } catch (error) {
    // Keep the startup error; a failure to close what was half-built is only logged. No new chat
    // message is admitted while the channels disconnect.
    chatAgent?.close();
    await closeInOrder([
      () =>
        disconnectChatWithin("after a failed start", (message, cause) =>
          console.error(message, ...(cause === undefined ? [] : [cause])),
        ),
      () => storage.close(),
    ]).catch((closeError: unknown) => {
      console.error("hex: cleaning up after a failed start also failed", closeError);
    });
    throw error;
  }
}
