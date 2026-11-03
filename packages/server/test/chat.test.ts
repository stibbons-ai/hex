import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleLogger } from "@mastra/core/logger";
import type { IMastraLogger } from "@mastra/core/logger";
import { LibSQLStore } from "@mastra/libsql";
import { type ChatOptions, type RunningServer, type ServerOptions, startServer } from "../src";
import { CHAT_ERROR_REPLY, CHAT_RESOURCE_ID, createChatAgent } from "../src/chat";
import { FakeChatAdapter } from "./fake-chat-adapter";
import { REPLY, mockModel } from "./mock-model";

const DANIEL = "U0DANIEL";
const STRANGER = "U0STRANGER";
const IGNORED = "hex: ignored message from a sender not on the allowlist";

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

function chatOptions(adapter: FakeChatAdapter, model = mockModel()): ChatOptions {
  return { model, channels: { fake: { adapter, allowlist: [DANIEL] } } };
}

function serverOptions(chat: ChatOptions, options: Partial<ServerOptions> = {}): ServerOptions {
  return {
    databasePath: join(directory, `chat-${databases++}`, "mastra.db"),
    port: 0,
    logger: false,
    chat,
    ...options,
  };
}

async function start(model = mockModel()) {
  const adapter = new FakeChatAdapter();
  const server = await startServer(serverOptions(chatOptions(adapter, model)));
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

async function allMessages(server: RunningServer) {
  const store = await memoryStore(server);
  const threads = await allThreads(server);
  const lists = await Promise.all(
    threads.map(({ id }) => store.listMessages({ threadId: id, perPage: false })),
  );
  return lists.flatMap(({ messages }) => messages);
}

/** Runs `act` with the server's logger method spied on; returns the calls. */
async function logged(
  server: RunningServer,
  level: "warn" | "error",
  act: () => Promise<void>,
): Promise<unknown[][]> {
  const spy = spyOn(server.mastra.getLogger(), level);
  try {
    await act();
    return spy.mock.calls;
  } finally {
    spy.mockRestore();
  }
}

describe("chat channels (fake adapter)", () => {
  test("a foreign sender's DM gets no reply, nothing is stored, and one line without the text is logged", async () => {
    const { server, adapter } = await start();
    // receive() resolves once the handler returned, so the log line proves the guard ran.
    const warnings = await logged(server, "warn", () =>
      adapter.receive({ conversation: "dm-stranger", sender: STRANGER, text: "secret plans" }),
    );
    expect(adapter.posted).toEqual([]);
    expect(await allThreads(server)).toEqual([]);
    expect(warnings).toEqual([[IGNORED, { platform: "fake", sender: STRANGER }]]);
    expect(JSON.stringify(warnings)).not.toContain("secret plans");
  });

  test("a foreign sender's @mention in a channel is ignored the same way", async () => {
    const { server, adapter } = await start();
    const warnings = await logged(server, "warn", () =>
      adapter.receive({
        conversation: "general",
        sender: STRANGER,
        text: "@hex leak",
        mention: true,
      }),
    );
    expect(adapter.posted).toEqual([]);
    expect(await allThreads(server)).toEqual([]);
    expect(warnings).toEqual([[IGNORED, { platform: "fake", sender: STRANGER }]]);
    expect(JSON.stringify(warnings)).not.toContain("leak");
  });

  test("an allowlisted sender is answered, and the conversation is stored under resource daniel", async () => {
    const { server, adapter } = await start();
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi hex" });
    await adapter.posts(1);
    expect(adapter.posted[0]).toEqual({ threadId: "fake:dm-daniel", text: REPLY });

    const [thread, ...others] = await allThreads(server);
    expect(others).toEqual([]);
    expect(thread?.resourceId).toBe(CHAT_RESOURCE_ID);
    const messages = await allMessages(server);
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
    const before = await allMessages(server);

    const warnings = await logged(server, "warn", () =>
      adapter.receive({ conversation: "general", sender: STRANGER, text: "me too" }),
    );
    // The thread is followed, so the message reached the (guarded) subscribed-message handler.
    expect(warnings).toEqual([[IGNORED, { platform: "fake", sender: STRANGER }]]);
    expect(adapter.posted).toHaveLength(1);
    expect(await allMessages(server)).toEqual(before);

    // Daniel's follow-up in the same thread, without a mention, is answered.
    await adapter.receive({ conversation: "general", sender: DANIEL, text: "and now?" });
    await adapter.posts(2);
  });

  test("earlier messages from others in a channel thread stay out of memory", async () => {
    const { server, adapter } = await start();
    adapter.history.set("general", [
      adapter.message({ conversation: "general", sender: STRANGER, text: "stranger history" }),
    ]);
    await adapter.receive({
      conversation: "general",
      sender: DANIEL,
      text: "@hex hi",
      mention: true,
    });
    await adapter.posts(1);
    const messages = await allMessages(server);
    expect(messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).not.toContain("stranger history");
  });

  test("a stranger's button click is ignored", async () => {
    const { server, adapter } = await start();
    const warnings = await logged(server, "warn", () =>
      adapter.click("general", STRANGER, "tool_approve:call-1"),
    );
    expect(warnings).toEqual([[IGNORED, { platform: "fake", sender: STRANGER }]]);
  });

  test("slash commands are not answered, not even Daniel's", async () => {
    const { server, adapter } = await start();
    await adapter.slash("general", DANIEL, "/hex", "hi");
    expect(adapter.posted).toEqual([]);
    expect(await allThreads(server)).toEqual([]);
  });

  test("a failed run posts a generic reply; the detail goes to the log only", async () => {
    const { server, adapter } = await start(
      mockModel({
        before: async () => {
          throw new Error("provider exploded, request req_123");
        },
      }),
    );
    const errors = await logged(server, "error", async () => {
      await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi" });
      await adapter.posts(1);
    });
    expect(adapter.posted).toEqual([{ threadId: "fake:dm-daniel", text: CHAT_ERROR_REPLY }]);
    expect(JSON.stringify(errors)).toContain("provider exploded, request req_123");
  });

  test("the agent's memory has working memory on, scoped to the resource", async () => {
    const { agent } = createChatAgent(chatOptions(new FakeChatAdapter()));
    const memory = await agent.getMemory();
    expect(memory?.getMergedThreadConfig().workingMemory).toMatchObject({
      enabled: true,
      scope: "resource",
    });
  });

  test("a channel whose key differs from its adapter's platform is rejected", () => {
    const adapter = new FakeChatAdapter();
    expect(() =>
      createChatAgent({
        model: mockModel(),
        channels: { slack: { adapter, allowlist: [DANIEL] } },
      }),
    ).toThrow('chat channel "slack": its adapter reports platform "fake"');
  });
});

describe("chat channel lifecycle", () => {
  test("start connects the channel and stop() disconnects it before Mastra shuts down", async () => {
    const adapter = new FakeChatAdapter();
    const server = await startServer(serverOptions(chatOptions(adapter)));
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

  test("stop() lets a reply in progress finish before Mastra shuts down", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const model = mockModel({
      before: async () => {
        entered.resolve();
        await release.promise;
        // A real delay on purpose: the run must still be busy when stop() moves on, which only
        // stop() waiting for it prevents; there is no event to await instead.
        await Bun.sleep(100);
      },
    });
    const adapter = new FakeChatAdapter();
    const server = await startServer(serverOptions(chatOptions(adapter, model)));
    const order: string[] = [];
    const disconnect = adapter.disconnect.bind(adapter);
    adapter.disconnect = async () => {
      await disconnect();
      // Only now, with stop() under way, may the run go on.
      release.resolve();
    };
    const post = adapter.postMessage.bind(adapter);
    adapter.postMessage = async (threadId, message) => {
      order.push("reply");
      return post(threadId, message);
    };
    const shutdown = server.mastra.shutdown.bind(server.mastra);
    server.mastra.shutdown = async () => {
      order.push("mastra");
      await shutdown();
    };
    const handled = adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi" });
    await entered.promise;
    const errors = await logged(server, "error", () => server.stop());
    await handled;
    expect(order).toEqual(["reply", "mastra"]);
    expect(errors).toEqual([]);
  });

  test("a channel that fails to connect fails startup and leaves nothing open", async () => {
    const adapter = new FakeChatAdapter();
    const failure = new Error("connect refused");
    adapter.connectError = failure;
    await expectFailedStart(adapter, (failed) => expect(failed).rejects.toBe(failure));
  });

  test("a channel that never connects fails startup at the deadline", async () => {
    const adapter = new FakeChatAdapter();
    adapter.connectWait = new Promise(() => {});
    await expectFailedStart(
      adapter,
      (failed) => expect(failed).rejects.toThrow("hex: chat channels did not connect within 50 ms"),
      { chatStartTimeoutMs: 50 },
    );
  });

  test("a channel that connects but fails its check fails startup", async () => {
    const adapter = new FakeChatAdapter();
    const chat: ChatOptions = {
      model: mockModel(),
      channels: {
        fake: {
          adapter,
          allowlist: [DANIEL],
          verify: () => {
            throw new Error("token rejected");
          },
        },
      },
    };
    await expectFailedStart(
      adapter,
      (failed) => expect(failed).rejects.toThrow('chat channel "fake": token rejected'),
      {},
      chat,
    );
  });

  test("an HTTP server that fails to start after the channel connected closes the channel", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const adapter = new FakeChatAdapter();
      const close = spyOn(LibSQLStore.prototype, "close");
      try {
        const failed = startServer(serverOptions(chatOptions(adapter), { port: taken.port! }));
        await expect(failed).rejects.toThrow(/EADDRINUSE|in use/i);
        expect(adapter.disconnects).toBe(1);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
      }
    } finally {
      await taken.stop(true);
    }
  });

  test("an empty allowlist is logged once at startup", async () => {
    const logger = new ConsoleLogger({ level: "error" }) as IMastraLogger;
    const warn = spyOn(logger, "warn");
    const adapter = new FakeChatAdapter();
    const server = await startServer(
      serverOptions(
        { model: mockModel(), channels: { fake: { adapter, allowlist: [] } } },
        { logger },
      ),
    );
    servers.push(server);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("allowlist"))).toEqual([
      ['hex: chat channel "fake": empty allowlist, nobody will be answered'],
    ]);
  });
});

/**
 * Starts a server on a free port with `adapter`, expects the start to fail as `check` says, and
 * then checks nothing is left open: adapter disconnected, store closed, port not bound.
 */
async function expectFailedStart(
  adapter: FakeChatAdapter,
  check: (failed: Promise<RunningServer>) => unknown,
  options: Partial<ServerOptions> = {},
  chat: ChatOptions = chatOptions(adapter),
) {
  const close = spyOn(LibSQLStore.prototype, "close");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const free = probe.port!;
  await probe.stop(true);
  try {
    await check(startServer(serverOptions(chat, { port: free, ...options })));
    expect(adapter.disconnects).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    // Nothing listens on the port: the HTTP server never started.
    await expect(fetch(`http://127.0.0.1:${free}/health`)).rejects.toThrow();
  } finally {
    close.mockRestore();
  }
}
