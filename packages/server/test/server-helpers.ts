// Helpers for tests that start the real server: its options, workflows and client, what it
// persisted, its warnings, and the environment around it.
import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalStore, toMastraSchema } from "@hex/adapters";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { DuckDBStore } from "@mastra/duckdb";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { Schema } from "effect";
import type { RunningServer, ServerOptions, contract } from "../src";
import { CHAT_RESOURCE_ID } from "../src/chat";
import { CHAT_STATE_TYPE, chatStores } from "../src/chat-state";
import { within } from "./timeouts";

export const Message = toMastraSchema(Schema.Struct({ message: Schema.String }));

/** A workflow with one step, named `id` both unless `stepId` names the step, from Message to Message. */
export function oneStep(
  id: string,
  execute: (input: typeof Message.Type) => Promise<typeof Message.Type>,
  stepId = id,
) {
  return createWorkflow({ id, inputSchema: Message, outputSchema: Message })
    .then(
      createStep({
        id: stepId,
        inputSchema: Message,
        outputSchema: Message,
        execute: ({ inputData }) => execute(inputData),
      }),
    )
    .commit();
}

export const echo = oneStep("echo", async (input) => input);

/** The typed oRPC client a caller of the API uses. */
export function client(server: RunningServer) {
  return createORPCClient<ContractRouterClient<typeof contract>>(
    new RPCLink({ url: new URL("/rpc", server.url) }),
  );
}

/**
 * Sets each variable in `values` (`undefined` deletes it); returns what puts the previous values
 * back.
 */
export function setEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.keys(values).map((name) => [name, process.env[name]] as const);
  const apply = (entries: Iterable<readonly [string, string | undefined]>) => {
    for (const [name, value] of entries) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(Object.entries(values));
  return () => apply(saved);
}

/**
 * Server options with fresh databases `<directory>/<name>/mastra.db` and
 * `<directory>/<name>/observability.duckdb`, a free port, no log.
 */
export function serverOptions(
  directory: string,
  name: string,
  rest: Partial<ServerOptions>,
): ServerOptions {
  return {
    databasePath: join(directory, name, "mastra.db"),
    observabilityPath: join(directory, name, "observability.duckdb"),
    port: 0,
    logger: false,
    ...rest,
  };
}

/**
 * What a stopped server persisted at `databasePath`: its memory threads, their messages, and the
 * working memory of resource {@link CHAT_RESOURCE_ID}.
 */
export async function stored(databasePath: string) {
  const storage = await createLocalStore(databasePath);
  try {
    await storage.init();
    const store = await storage.getStore("memory");
    if (!store) throw new Error("no memory store");
    const { threads } = await store.listThreads({ perPage: false });
    const lists = await Promise.all(
      threads.map(({ id }) => store.listMessages({ threadId: id, perPage: false })),
    );
    const messages = lists.flatMap((list) => list.messages);
    const resource = await store.getResourceById({ resourceId: CHAT_RESOURCE_ID });
    return { threads, messages, workingMemory: resource?.workingMemory };
  } finally {
    await storage.close();
  }
}

/** The Chat state value a stopped server persisted at `databasePath` under `key`, if any. */
export async function storedChatState(databasePath: string, key: string) {
  const storage = await createLocalStore(databasePath);
  try {
    await storage.init();
    const { threadState } = await chatStores(storage);
    return await threadState.getState({ threadId: key, type: CHAT_STATE_TYPE });
  } finally {
    await storage.close();
  }
}

/**
 * Every row of Mastra's thread-state table a stopped server left at `databasePath`. Opened
 * read-write: a read-only open of the WAL database right after stop could find no `-shm` file
 * and fail with SQLITE_CANTOPEN.
 */
export function chatStateRows(databasePath: string) {
  const database = new Database(databasePath);
  try {
    return database.query('SELECT "threadId", "type" FROM mastra_thread_state').all();
  } finally {
    database.close();
  }
}

/** The root spans (one per trace) in the DuckDB file at `path`, read with a fresh store. */
export async function rootSpans(path: string) {
  const duckdb = new DuckDBStore({ path });
  try {
    const { spans } = await duckdb.observability.listTraces({ pagination: { perPage: 100 } });
    return spans.map(({ entityType, entityName }) => ({ entityType, entityName }));
  } finally {
    await duckdb.close();
  }
}

/**
 * Whether another process can open the DuckDB file at `path` read-write, i.e. no process (this
 * one included) still holds its lock. The error, when it can't, is in `stderr`.
 */
export async function openableElsewhere(path: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { DuckDBInstance } from "@duckdb/node-api";
       (await DuckDBInstance.create(${JSON.stringify(path)})).closeSync();`,
    ],
    // From the package that installs @mastra/duckdb, whose dependency @duckdb/node-api is.
    { cwd: dirname(fileURLToPath(import.meta.resolve("@mastra/duckdb"))), stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { openable: code === 0, stderr };
}

/**
 * Resolves with the arguments of the first `count` warnings `message` the server's logger logs
 * from now on; waits at most 2 s.
 */
export function warnings(server: RunningServer, message: string, count = 1) {
  const enough = Promise.withResolvers<unknown[][]>();
  const seen: unknown[][] = [];
  const logger = server.mastra.getLogger();
  const warn = logger.warn.bind(logger);
  spyOn(logger, "warn").mockImplementation((...args: Parameters<typeof logger.warn>) => {
    if (args[0] === message && seen.push(args) === count) enough.resolve(seen.slice());
    warn(...args);
  });
  return within(enough.promise, `${count} warning(s) "${message}"`);
}
