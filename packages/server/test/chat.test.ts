import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { LibSQLStore } from "@mastra/libsql";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { type RunningServer, startServer } from "../src";
import { CHAT_AGENT_ID, CHAT_RESOURCE_ID } from "../src/chat";
import { FakeChatAdapter } from "./fake-chat-adapter";

const DANIEL = "U0DANIEL";
const STRANGER = "U0STRANGER";
const REPLY = "hello from hex";

let directory: string;
let databases = 0;
const servers: RunningServer[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-chat-"));
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  await rm(directory, { recursive: true, force: true });
});

function mockModel(): MastraModelConfig {
  return createMockModel({ mockText: REPLY, version: "v2" }) as MastraModelConfig;
}

async function start(adapter = new FakeChatAdapter()) {
  const server = await startServer({
    databasePath: join(directory, `chat-${databases++}`, "mastra.db"),
    port: 0,
    logger: false,
    chat: { model: mockModel(), adapters: { fake: adapter }, allowlists: { fake: [DANIEL] } },
  });
  servers.push(server);
  return { server, adapter };
}

async function memoryStore(server: RunningServer) {
  const store = await server.mastra.getStorage()?.getStore("memory");
  if (!store) throw new Error("no memory store");
  return store;
}

async function allThreads(server: RunningServer) {
  return (await (await memoryStore(server)).listThreads({ perPage: false })).threads;
}

describe("chat channels (fake adapter)", () => {
  test("a foreign sender gets no reply, nothing is stored, and one line without the text is logged", async () => {
    const { server, adapter } = await start();
    const warned = spyOn(server.mastra.getLogger(), "warn");
    try {
      await adapter.receive({
        conversation: "dm-stranger",
        sender: STRANGER,
        text: "secret plans",
      });
      // receive() resolves once the handler returned, so the log line below proves the guard ran.
      expect(adapter.posted).toEqual([]);
      expect(await allThreads(server)).toEqual([]);
      const ignored = warned.mock.calls.filter(([message]) => String(message).includes("ignored"));
      expect(ignored).toEqual([
        [
          "hex: ignored message from a sender not on the allowlist",
          { channel: "fake", sender: STRANGER },
        ],
      ]);
      expect(JSON.stringify(warned.mock.calls)).not.toContain("secret plans");
    } finally {
      warned.mockRestore();
    }
  });

  test("an allowlisted sender is answered, and the conversation is stored under resource daniel", async () => {
    const { server, adapter } = await start();
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi hex" });
    await adapter.posts(1);
    expect(adapter.posted[0]).toEqual({ threadId: "fake:dm-daniel", text: REPLY });

    const [thread, ...others] = await allThreads(server);
    expect(others).toEqual([]);
    expect(thread?.resourceId).toBe(CHAT_RESOURCE_ID);
    const { messages } = await (
      await memoryStore(server)
    ).listMessages({
      threadId: thread!.id,
      perPage: false,
    });
    // Channel messages reach the agent as signals.
    expect(messages.map((message) => message.role)).toEqual(["signal", "assistant"]);
    expect(messages.every((message) => message.resourceId === CHAT_RESOURCE_ID)).toBe(true);
  });

  test("two conversations are two threads of the same resource; a follow-up stays in its thread", async () => {
    const { server, adapter } = await start();
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "first" });
    await adapter.posts(1);
    await adapter.receive({
      conversation: "general",
      sender: DANIEL,
      text: "@hex second",
      mention: true,
    });
    await adapter.posts(2);
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "third" });
    await adapter.posts(3);

    const threads = await allThreads(server);
    expect(threads).toHaveLength(2);
    expect(new Set(threads.map((thread) => thread.resourceId))).toEqual(
      new Set([CHAT_RESOURCE_ID]),
    );
    expect(new Set(threads.map((thread) => thread.metadata?.["channel_externalThreadId"]))).toEqual(
      new Set(["fake:dm-daniel", "fake:general"]),
    );
  });

  test("a stranger replying in a thread hex follows is ignored too", async () => {
    const { server, adapter } = await start();
    await adapter.receive({
      conversation: "general",
      sender: DANIEL,
      text: "@hex hi",
      mention: true,
    });
    await adapter.posts(1);
    const [thread] = await allThreads(server);
    const store = await memoryStore(server);
    const before = (await store.listMessages({ threadId: thread!.id, perPage: false })).messages;

    const warned = spyOn(server.mastra.getLogger(), "warn");
    try {
      await adapter.receive({ conversation: "general", sender: STRANGER, text: "me too" });
      // The thread is followed, so the message reached the (guarded) subscribed-message handler.
      expect(warned).toHaveBeenCalledWith(
        "hex: ignored message from a sender not on the allowlist",
        {
          channel: "fake",
          sender: STRANGER,
        },
      );
    } finally {
      warned.mockRestore();
    }
    expect(adapter.posted).toHaveLength(1);
    const after = (await store.listMessages({ threadId: thread!.id, perPage: false })).messages;
    expect(after).toEqual(before);

    // Daniel's follow-up in the same thread, without a mention, is answered.
    await adapter.receive({ conversation: "general", sender: DANIEL, text: "and now?" });
    await adapter.posts(2);
  });

  test("the agent's memory has working memory on", async () => {
    const { server } = await start();
    const agent = server.mastra.getAgent(CHAT_AGENT_ID) as Agent;
    const memory = await agent.getMemory();
    expect(memory?.getMergedThreadConfig().workingMemory?.enabled).toBe(true);
  });
});

describe("chat channel lifecycle", () => {
  test("start connects the channel and stop() disconnects it before Mastra shuts down", async () => {
    const adapter = new FakeChatAdapter();
    const server = await startServer({
      databasePath: join(directory, "lifecycle", "mastra.db"),
      port: 0,
      logger: false,
      chat: { model: mockModel(), adapters: { fake: adapter }, allowlists: { fake: [DANIEL] } },
    });
    expect(adapter.connected).toBe(true);
    const order: string[] = [];
    const disconnect = adapter.disconnect.bind(adapter);
    adapter.disconnect = async () => {
      order.push("channel");
      await disconnect();
    };
    const shutdown = server.mastra.shutdown.bind(server.mastra);
    server.mastra.shutdown = async () => {
      order.push("mastra");
      await shutdown();
    };
    await server.stop();
    expect(adapter.connected).toBe(false);
    expect(order).toEqual(["channel", "mastra"]);
  });

  test("a channel that fails to connect fails startup and leaves nothing open", async () => {
    const adapter = new FakeChatAdapter();
    const failure = new Error("connect refused");
    adapter.connectError = failure;
    const close = spyOn(LibSQLStore.prototype, "close");
    const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const free = port.port!;
    await port.stop(true);
    try {
      const failed = startServer({
        databasePath: join(directory, "connect-fails", "mastra.db"),
        port: free,
        logger: false,
        chat: { model: mockModel(), adapters: { fake: adapter }, allowlists: { fake: [DANIEL] } },
      });
      await expect(failed).rejects.toBe(failure);
      expect(adapter.disconnects).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
      // Nothing listens on the port: the HTTP server never started.
      await expect(fetch(`http://127.0.0.1:${free}/health`)).rejects.toThrow();
    } finally {
      close.mockRestore();
    }
  });
});
