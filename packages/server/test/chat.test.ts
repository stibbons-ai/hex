import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleLogger } from "@mastra/core/logger";
import type { IMastraLogger } from "@mastra/core/logger";
import { InMemoryStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { type ChatOptions, type RunningServer, type ServerOptions, startServer } from "../src";
import { CHAT_AGENT_ID, CHAT_ERROR_REPLY, CHAT_RESOURCE_ID, createChatAgent } from "../src/chat";
import { chatStores } from "../src/chat-state";
import { FakeChatAdapter } from "./fake-chat-adapter";
import { REPLY, heldModel, mockModel, numberedModel, toolCallingModel } from "./mock-model";
import { serverOptions as freshServerOptions, stored } from "./server-helpers";
import { freePort, within } from "./timeouts";

const DANIEL = "U0DANIEL";
const STRANGER = "U0STRANGER";
const IGNORED = "hex: ignored message from a sender not on the allowlist";
const TOOL_CALL = "hex: tool call";
const MEMORY = "# User Information\n- First Name: Daniel";

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
  return freshServerOptions(directory, `chat-${databases++}`, { chat, ...options });
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
  level: "info" | "warn" | "error",
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

/** The tool-call lines among a logger method's calls. */
function toolCallLines(calls: unknown[][]) {
  return calls.filter(([message]) => message === TOOL_CALL);
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

  test("a run that calls a tool posts only the final answer: no tool name, args or result", async () => {
    const { server, adapter } = await start(toolCallingModel({ memory: MEMORY }));
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "I'm Daniel" });
    await adapter.posts(1);
    expect(adapter.posted).toEqual([{ threadId: "fake:dm-daniel", text: REPLY }]);
    // The tool did run: the working memory holds what the model wrote.
    const resource = await (
      await memoryStore(server)
    ).getResourceById({
      resourceId: CHAT_RESOURCE_ID,
    });
    expect(resource?.workingMemory).toContain("First Name: Daniel");
  });

  test("in a channel thread, the public case, a tool-calling run posts only the final answer", async () => {
    const { adapter } = await start(toolCallingModel({ memory: MEMORY }));
    await adapter.receive({
      conversation: "general",
      sender: DANIEL,
      text: "@hex I'm Daniel",
      mention: true,
    });
    expect(adapter.posted).toEqual([{ threadId: "fake:general", text: REPLY }]);
  });

  test("a tool call is logged as one line with the tool's name, never its args or result", async () => {
    const calls: unknown[] = [];
    const model = toolCallingModel(
      { memory: MEMORY },
      { before: async (options) => void calls.push(options) },
    );
    const adapter = new FakeChatAdapter();
    // Provider options are run defaults too: both must reach a channel run.
    const server = await startServer(
      serverOptions({
        ...chatOptions(adapter, model),
        providerOptions: { anthropic: { effort: "low" } },
      }),
    );
    servers.push(server);
    const lines = await logged(server, "info", () =>
      adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "I'm Daniel" }),
    );
    expect(toolCallLines(lines)).toEqual([
      [TOOL_CALL, { tool: "updateWorkingMemory", toolCallId: "call-1", ok: true }],
    ]);
    expect(JSON.stringify(lines)).not.toContain("First Name");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ providerOptions: { anthropic: { effort: "low" } } });
    }
  });

  test("a tool that throws is logged as a warning with its kind, not its message", async () => {
    const { server, adapter } = await start(toolCallingModel({ memory: MEMORY }));
    const memory = await server.mastra.getAgent(CHAT_AGENT_ID).getMemory();
    if (!memory) throw new Error("no memory");
    spyOn(memory, "updateWorkingMemory").mockRejectedValue(new TypeError(`can't store ${MEMORY}`));
    const warnings = await logged(server, "warn", () =>
      adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "I'm Daniel" }),
    );
    expect(toolCallLines(warnings)).toEqual([
      [TOOL_CALL, { tool: "updateWorkingMemory", toolCallId: "call-1", ok: false, error: "error" }],
    ]);
    expect(JSON.stringify(warnings)).not.toContain("First Name");
    expect(adapter.posted).toEqual([{ threadId: "fake:dm-daniel", text: REPLY }]);
  });

  test("a tool call with invalid input is logged as a warning without the input", async () => {
    const { server, adapter } = await start(toolCallingModel({ memory: { text: MEMORY } }));
    const warnings = await logged(server, "warn", () =>
      adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "I'm Daniel" }),
    );
    // Checks hex's line only: Mastra's own "Tool input validation failed" warning quotes the args.
    expect(toolCallLines(warnings)).toEqual([
      [
        TOOL_CALL,
        { tool: "updateWorkingMemory", toolCallId: "call-1", ok: false, error: "invalid input" },
      ],
    ]);
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

  test("configured provider options reach the model call of a channel run", async () => {
    const calls: unknown[] = [];
    const model = mockModel({ before: async (options) => void calls.push(options) });
    const adapter = new FakeChatAdapter();
    const server = await startServer(
      serverOptions({
        ...chatOptions(adapter, model),
        providerOptions: { anthropic: { effort: "low" } },
      }),
    );
    servers.push(server);
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi" });
    await adapter.posts(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ providerOptions: { anthropic: { effort: "low" } } });
  });

  test("the agent's memory has working memory on, scoped to the resource", async () => {
    const stores = await chatStores(new InMemoryStore());
    const { agent } = createChatAgent(chatOptions(new FakeChatAdapter()), stores);
    const memory = await agent.getMemory();
    expect(memory?.getMergedThreadConfig().workingMemory).toMatchObject({
      enabled: true,
      scope: "resource",
    });
  });

  test("a channel whose key differs from its adapter's platform is rejected", async () => {
    const adapter = new FakeChatAdapter();
    const stores = await chatStores(new InMemoryStore());
    expect(() =>
      createChatAgent(
        { model: mockModel(), channels: { slack: { adapter, allowlist: [DANIEL] } } },
        stores,
      ),
    ).toThrow('chat channel "slack": its adapter reports platform "fake"');
  });
});

describe("chat conversation queue", () => {
  test("a message sent while its conversation's run is busy is answered and saved, even when stop() follows its reply at once", async () => {
    const FIRST = "first words";
    const SECOND = "second words";
    const { model, prompts, busy, release } = heldModel();
    const adapter = new FakeChatAdapter();
    const options = serverOptions(chatOptions(adapter, model));
    const server = await startServer(options);
    const stopped = Promise.withResolvers<void>();
    const post = adapter.postMessage.bind(adapter);
    adapter.postMessage = async (threadId, message) => {
      const posted = await post(threadId, message);
      // The reply posted by the model call that saw SECOND: stop 0 ms after it.
      if (prompts.at(-1)?.includes(SECOND)) stopped.resolve(server.stop());
      return posted;
    };
    const first = adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: FIRST });
    await within(busy, "the first run to start");
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: SECOND });
    release();
    await first;
    await within(stopped.promise, "stop() after the answer to the second message");

    const { threads, messages } = await stored(options.databasePath);
    expect(threads).toHaveLength(1);
    const exchange = messages.map((message) => [message.role, JSON.stringify(message.content)]);
    expect(exchange).toEqual([
      ["signal", expect.stringContaining(FIRST)],
      ["assistant", expect.stringContaining("reply 1")],
      ["signal", expect.stringContaining(SECOND)],
      ["assistant", expect.stringContaining("reply 2")],
    ]);
  });

  test("two first messages back to back in a new conversation share one memory thread", async () => {
    const { server, adapter } = await start(numberedModel());
    await Promise.all([
      adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "one" }),
      adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "two" }),
    ]);
    await adapter.posts(2);

    const threads = (await allThreads(server)).filter(
      (thread) => thread.metadata?.["channel_externalThreadId"] === "fake:dm-daniel",
    );
    expect(threads).toHaveLength(1);
    const messages = await allMessages(server);
    expect(messages.map((message) => message.threadId)).toEqual(messages.map(() => threads[0]?.id));
    const said = JSON.stringify(messages.filter((message) => message.role === "signal"));
    expect(said).toContain("one");
    expect(said).toContain("two");
  });

  /**
   * Daniel @-mentions hex in a channel thread; while that run is busy, `queued` arrive in order.
   * Returns hex's warnings, each model call's prompt, and the fields of every batch the Chat SDK
   * handed on (its `message-dequeued` log lines).
   */
  async function queuedBehindBusyRun(queued: { sender: string; text: string }[]) {
    const { model, prompts, busy, release } = heldModel();
    const { server, adapter } = await start(model);
    const conversation = "general";
    const chatLogger = server.mastra.getAgent(CHAT_AGENT_ID).getChannels()?.sdk?.getLogger();
    if (!chatLogger) throw new Error("no chat logger");
    const info = spyOn(chatLogger, "info");
    try {
      const warnings = await logged(server, "warn", async () => {
        const first = adapter.receive({
          conversation,
          sender: DANIEL,
          text: "@hex hi",
          mention: true,
        });
        await within(busy, "the first run to start");
        for (const message of queued) await adapter.receive({ conversation, ...message });
        release();
        await first;
      });
      const batches = info.mock.calls
        .filter(([event]) => event === "message-dequeued")
        .map(([, fields]) => fields);
      return { server, adapter, warnings, prompts, batches };
    } finally {
      info.mockRestore();
    }
  }

  test("messages queued behind a busy run are one turn per sender: a stranger's is ignored and stays out of Daniel's", async () => {
    const { server, adapter, warnings, prompts, batches } = await queuedBehindBusyRun([
      { sender: STRANGER, text: "stranger one" },
      { sender: STRANGER, text: "stranger two" },
      { sender: DANIEL, text: "daniel two" },
      { sender: DANIEL, text: "daniel three" },
    ]);
    // All four were handed on as one batch: the latest plus three skipped, none dropped.
    expect(batches).toEqual([expect.objectContaining({ skippedCount: 3 })]);
    // Both stranger messages reached the guard as one turn: one line, without their text.
    expect(warnings).toEqual([[IGNORED, { platform: "fake", sender: STRANGER }]]);
    expect(JSON.stringify(warnings)).not.toContain("stranger");
    // Daniel's two queued messages were one turn too, answered once, with neither stranger message.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("daniel two");
    expect(prompts[1]).toContain("daniel three");
    expect(prompts[1]).not.toContain("stranger");
    expect(adapter.posted.map(({ text }) => text)).toEqual(["reply 1", "reply 2"]);
    const stored = JSON.stringify(await allMessages(server));
    expect(stored).toContain("daniel two");
    expect(stored).toContain("daniel three");
    expect(stored).not.toContain("stranger");
  });

  test("a stranger's message queued between two of Daniel's stays out of both of Daniel's turns", async () => {
    const { server, adapter, warnings, prompts, batches } = await queuedBehindBusyRun([
      { sender: DANIEL, text: "daniel two" },
      { sender: STRANGER, text: "stranger one" },
      { sender: DANIEL, text: "daniel three" },
    ]);
    expect(batches).toEqual([expect.objectContaining({ skippedCount: 2 })]);
    expect(warnings).toEqual([[IGNORED, { platform: "fake", sender: STRANGER }]]);
    // Not consecutive, so Daniel's two messages are two turns, each answered.
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("daniel two");
    expect(prompts[1]).not.toContain("daniel three");
    expect(prompts[2]).toContain("daniel three");
    for (const prompt of prompts) expect(prompt).not.toContain("stranger");
    expect(adapter.posted.map(({ text }) => text)).toEqual(["reply 1", "reply 2", "reply 3"]);
    const stored = JSON.stringify(await allMessages(server));
    expect(stored).toContain("daniel two");
    expect(stored).toContain("daniel three");
    expect(stored).not.toContain("stranger");
  });

  test("a message still queued when stop() begins is dropped and logged, not answered", async () => {
    const { model, busy, release } = heldModel();
    const adapter = new FakeChatAdapter();
    const options = serverOptions(chatOptions(adapter, model));
    const server = await startServer(options);
    const disconnect = adapter.disconnect.bind(adapter);
    adapter.disconnect = async () => {
      await disconnect();
      // Only now, with stop() under way, may the busy run go on.
      release();
    };
    const first = adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi" });
    await within(busy, "the first run to start");
    await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "late words" });
    let warnings: unknown[][] = [];
    const errors = await logged(server, "error", async () => {
      warnings = await logged(server, "warn", async () => {
        await server.stop();
        await first;
      });
    });
    expect(warnings).toEqual([
      ["hex: ignored message while hex is shutting down", { platform: "fake", sender: DANIEL }],
    ]);
    expect(errors).toEqual([]);
    expect(adapter.posted.map(({ text }) => text)).toEqual(["reply 1"]);
    expect(JSON.stringify((await stored(options.databasePath)).messages)).not.toContain(
      "late words",
    );
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

  test("a message that reaches hex after stop() began is dropped and logged", async () => {
    const adapter = new FakeChatAdapter();
    const server = await startServer(serverOptions(chatOptions(adapter)));
    const disconnect = adapter.disconnect.bind(adapter);
    let warnings: unknown[][] = [];
    let threads: unknown[] = ["not checked"];
    adapter.disconnect = async () => {
      // stop() has begun (it disconnects first); the platform still delivers one late message.
      warnings = await logged(server, "warn", () =>
        adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "late words" }),
      );
      threads = await allThreads(server);
      await disconnect();
    };
    await server.stop();
    expect(adapter.posted).toEqual([]);
    expect(threads).toEqual([]);
    expect(warnings).toEqual([
      ["hex: ignored message while hex is shutting down", { platform: "fake", sender: DANIEL }],
    ]);
    expect(JSON.stringify(warnings)).not.toContain("late words");
  });

  test("stop() logs replies its grace period cuts off", async () => {
    const entered = Promise.withResolvers<void>();
    // The run never finishes: the model waits forever.
    const model = mockModel({
      before: async () => {
        entered.resolve();
        await new Promise(() => {});
      },
    });
    const adapter = new FakeChatAdapter();
    const server = await startServer(
      serverOptions(chatOptions(adapter, model), { stopGraceMs: 50 }),
    );
    void adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi" });
    await within(entered.promise, "the run to start");
    const warnings = await logged(server, "warn", () => server.stop());
    expect(warnings).toContainEqual([
      "hex: stop: requests and chat replies still running after 50 ms were cut off (1 chat replies)",
    ]);
  });

  test("stop() gives up on a channel that never disconnects and still closes everything", async () => {
    const adapter = new FakeChatAdapter();
    adapter.disconnect = () => new Promise(() => {});
    const port = await freePort();
    const server = await startServer(
      serverOptions(chatOptions(adapter), { port, stopGraceMs: 50 }),
    );
    const close = spyOn(LibSQLStore.prototype, "close");
    try {
      const warnings = await logged(server, "warn", () => within(server.stop(), "stop()"));
      expect(warnings).toContainEqual(["hex: stop: chat channels did not disconnect within 50 ms"]);
      expect(close).toHaveBeenCalled();
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      close.mockRestore();
    }
  });

  test("stop() waits a second grace period for a channel still disconnecting, then cuts it off", async () => {
    const adapter = new FakeChatAdapter();
    adapter.disconnect = () => new Promise(() => {});
    const server = await startServer(serverOptions(chatOptions(adapter), { stopGraceMs: 300 }));
    let shutdownAfter = Number.NaN;
    let started = 0;
    const shutdown = server.mastra.shutdown.bind(server.mastra);
    server.mastra.shutdown = async () => {
      shutdownAfter = performance.now() - started;
      await shutdown();
    };
    const warnings = await logged(server, "warn", async () => {
      started = performance.now();
      await within(server.stop(), "stop()");
    });
    expect(warnings).toEqual([
      ["hex: stop: chat channels did not disconnect within 300 ms"],
      [
        "hex: stop: requests and chat replies still running after 300 ms were cut off, with the chat channels still disconnecting",
      ],
    ]);
    // Both grace periods, and no more: Mastra shuts down after 2 × 300 ms (timers may run late).
    expect(shutdownAfter).toBeGreaterThanOrEqual(590);
    expect(shutdownAfter).toBeLessThan(750);
  });

  test("a channel that finishes disconnecting in stop()'s second grace period isn't reported cut off", async () => {
    const entered = Promise.withResolvers<void>();
    // The run never finishes, so stop()'s second grace period runs out.
    const model = mockModel({
      before: async () => {
        entered.resolve();
        await new Promise(() => {});
      },
    });
    const adapter = new FakeChatAdapter();
    const disconnected = Promise.withResolvers<void>();
    adapter.disconnect = () => disconnected.promise;
    const server = await startServer(
      serverOptions(chatOptions(adapter, model), { stopGraceMs: 200 }),
    );
    void adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hi" });
    await within(entered.promise, "the run to start");
    const warn = spyOn(server.mastra.getLogger(), "warn");
    warn.mockImplementation((...args) => {
      // stop() gave up on the disconnect in its first step: it finishes in the second.
      if (args[0] === "hex: stop: chat channels did not disconnect within 200 ms") {
        disconnected.resolve();
      }
    });
    try {
      await within(server.stop(), "stop()");
      expect(warn.mock.calls).toEqual([
        ["hex: stop: chat channels did not disconnect within 200 ms"],
        [
          "hex: stop: requests and chat replies still running after 200 ms were cut off (1 chat replies)",
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a channel disconnect failing while stop() waits for a reply is logged once; the reply finishes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const model = mockModel({
      before: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const adapter = new FakeChatAdapter();
    const failing = Promise.withResolvers<void>();
    adapter.disconnect = () => failing.promise;
    const server = await startServer(
      serverOptions(chatOptions(adapter, model), { stopGraceMs: 200 }),
    );
    const order: string[] = [];
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
    await within(entered.promise, "the run to start");
    const logger = server.mastra.getLogger();
    const gaveUp = Promise.withResolvers<void>();
    const warn = spyOn(logger, "warn");
    warn.mockImplementation((...args) => {
      if (args[0] === "hex: stop: chat channels did not disconnect within 200 ms") {
        gaveUp.resolve();
      }
    });
    const error = spyOn(logger, "error");
    const failure = new Error("socket refused to close");
    try {
      const stopping = server.stop();
      await within(gaveUp.promise, "stop() to give up on the disconnect");
      failing.reject(failure);
      await failing.promise.catch(() => {});
      // Only now, with the disconnect failed during stop()'s second step, may the run go on.
      release.resolve();
      await within(stopping, "stop()");
      await handled;
      expect(warn.mock.calls).toEqual([
        ["hex: stop: chat channels did not disconnect within 200 ms"],
        ["hex: stop: disconnecting chat channels failed late", failure],
      ]);
      expect(error.mock.calls).toEqual([]);
      expect(order).toEqual(["reply", "mastra"]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("a channel disconnect that fails after stop() gave up on it is logged", async () => {
    const adapter = new FakeChatAdapter();
    const failing = Promise.withResolvers<void>();
    adapter.disconnect = () => failing.promise;
    const server = await startServer(serverOptions(chatOptions(adapter), { stopGraceMs: 50 }));
    const failure = new Error("socket refused to close");
    const warnings = await logged(server, "warn", async () => {
      await within(server.stop(), "stop()");
      failing.reject(failure);
      // hex's handler was attached first, so it has run once ours has.
      await failing.promise.catch(() => {});
    });
    expect(warnings).toContainEqual([
      "hex: stop: disconnecting chat channels failed late",
      failure,
    ]);
  });

  test("a failed start gives up on a channel that never disconnects", async () => {
    const adapter = new FakeChatAdapter();
    adapter.disconnect = () => new Promise(() => {});
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
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = startServer(serverOptions(chat, { stopGraceMs: 50 }));
      await expect(within(failed, "the start to fail")).rejects.toThrow("token rejected");
      expect(errors).toHaveBeenCalledWith(
        "hex: after a failed start: chat channels did not disconnect within 50 ms",
      );
    } finally {
      errors.mockRestore();
    }
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
      (failed) => expect(failed).rejects.toThrow("hex: chat channels did not start within 50 ms"),
      { chatStartTimeoutMs: 50 },
    );
  });

  test("a channel that finishes starting after the deadline is disconnected then", async () => {
    const adapter = new FakeChatAdapter();
    const late = Promise.withResolvers<void>();
    adapter.connectWait = late.promise;
    const disconnected = Promise.withResolvers<void>();
    const disconnect = adapter.disconnect.bind(adapter);
    adapter.disconnect = async () => {
      await disconnect();
      if (adapter.disconnects === 2) disconnected.resolve();
    };
    await expectFailedStart(
      adapter,
      (failed) => expect(failed).rejects.toThrow("did not start within 50 ms"),
      { chatStartTimeoutMs: 50 },
    );
    late.resolve();
    await within(disconnected.promise, "the late start to be disconnected");
    expect(adapter.connected).toBe(false);
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

  test("chat without channels is rejected", async () => {
    const stores = await chatStores(new InMemoryStore());
    expect(() => createChatAgent({ model: mockModel(), channels: {} }, stores)).toThrow(
      "chat needs at least one channel",
    );
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
  const free = await freePort();
  try {
    await within(
      Promise.resolve(check(startServer(serverOptions(chat, { port: free, ...options })))),
      "the start to fail",
    );
    expect(adapter.disconnects).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    // Nothing listens on the port: the HTTP server never started.
    await expect(fetch(`http://127.0.0.1:${free}/health`)).rejects.toThrow();
  } finally {
    close.mockRestore();
  }
}
