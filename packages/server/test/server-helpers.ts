// Helpers for tests that start the real server: its options, what it persisted, its warnings.
import { spyOn } from "bun:test";
import { join } from "node:path";
import { createLocalStore } from "@hex/adapters";
import type { RunningServer, ServerOptions } from "../src";
import { CHAT_RESOURCE_ID } from "../src/chat";
import { CHAT_STATE_TYPE, chatStores } from "../src/chat-state";
import { within } from "./timeouts";

/** Server options with a fresh database `<directory>/<name>/mastra.db`, a free port, no log. */
export function serverOptions(
  directory: string,
  name: string,
  rest: Partial<ServerOptions>,
): ServerOptions {
  return { databasePath: join(directory, name, "mastra.db"), port: 0, logger: false, ...rest };
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
