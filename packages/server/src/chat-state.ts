import { MastraStateAdapter } from "@mastra/core/channels";
import { MastraBaseError } from "@mastra/core/error";
import type { MastraCompositeStore, MemoryStorage, ThreadStateStorage } from "@mastra/core/storage";

/** The thread-state `type` under which hex keeps the Chat state it persists. */
export const CHAT_STATE_TYPE = "hex:chat-state";

/**
 * Keys persisted in hex's database rather than in memory: the Signal adapter's receive cursor
 * (`signal:receive-cursor:<account>`), so a restarted hex resumes the event stream after the last
 * event it processed.
 */
const PERSISTED_PREFIX = "signal:receive-cursor:";

/**
 * Runs a store call, rethrowing a store failure without the details Mastra adds: they name the
 * key, and so the bot account, and the adapter logs the error.
 */
async function withoutKey<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof MastraBaseError)) throw error;
    throw new Error(`hex: chat state store: ${error.message}`, { cause: error.cause });
  }
}

/** The stores of hex's database that keep the channels' Chat state. */
export interface ChatStores {
  memory: MemoryStorage;
  threadState: ThreadStateStorage;
}

/** The Chat state stores of `storage`; throws when it lacks one. */
export async function chatStores(storage: MastraCompositeStore): Promise<ChatStores> {
  const [memory, threadState] = await Promise.all([
    storage.getStore("memory"),
    storage.getStore("threadState"),
  ]);
  if (!memory || !threadState) throw new Error("hex: the store lacks a chat state domain");
  return { memory, threadState };
}

/**
 * Mastra's Chat state adapter (thread subscriptions persisted in memory storage; cache, locks,
 * dedupe keys and queues in memory), except that `get`/`set`/`delete` of the receive-cursor keys
 * go to the thread-state store of the same database, keyed by the state key under
 * {@link CHAT_STATE_TYPE}. Those keys never expire: the adapter sets them without a TTL.
 */
export class ChatState extends MastraStateAdapter {
  private readonly threadState: ThreadStateStorage;

  constructor({ memory, threadState }: ChatStores, getOwnerId: () => string | null) {
    super(memory, getOwnerId);
    this.threadState = threadState;
  }

  override async get<T = unknown>(key: string): Promise<T | null> {
    if (!key.startsWith(PERSISTED_PREFIX)) return super.get<T>(key);
    const value = await withoutKey(() =>
      this.threadState.getState<T>({ threadId: key, type: CHAT_STATE_TYPE }),
    );
    return value ?? null;
  }

  override async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    if (!key.startsWith(PERSISTED_PREFIX)) return super.set(key, value, ttlMs);
    await withoutKey(() =>
      this.threadState.setState({ threadId: key, type: CHAT_STATE_TYPE, value }),
    );
  }

  override async delete(key: string): Promise<void> {
    if (!key.startsWith(PERSISTED_PREFIX)) return super.delete(key);
    await withoutKey(() => this.threadState.deleteState({ threadId: key, type: CHAT_STATE_TYPE }));
  }
}
