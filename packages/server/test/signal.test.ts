// The real Signal adapter over signal-cli's HTTP transport, built from a config file, against a
// fake signal-cli on loopback (JSON-RPC plus the server-sent receive events). Never reaches
// Signal, Slack or a model provider.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "@hex/adapters";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Adapter } from "chat";
import { type RunningServer, type ServerOptions, startServer } from "../src";
import { CHAT_AGENT_ID, CHAT_RESOURCE_ID } from "../src/chat";
import { loadChatConfig } from "../src/config";
import { BOT_ACCOUNT, DANIEL, type FakeSignalCli, fakeSignalCli } from "./fake-signal-cli";
import { DANIEL as DANIEL_SLACK, directMessage, fakeSlack, slackEnv } from "./fake-slack";
import { REPLY, mockModel, toolCallingModel } from "./mock-model";
import { freePort, within } from "./timeouts";

const STRANGER = "5e5e5e5e-0000-4000-8000-00000000057a";
const IGNORED = "hex: ignored message from a sender not on the allowlist";

let directory: string;
let configPath: string;
let bothPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-signal-"));
  configPath = join(directory, "hex.json");
  bothPath = join(directory, "both.json");
  const signal = { options: {}, allowlist: [DANIEL] };
  const slack = { options: { mode: "socket" }, allowlist: [DANIEL_SLACK] };
  const model = "anthropic/claude-opus-5-5";
  await writeFile(configPath, JSON.stringify({ chat: { model, channels: { signal } } }));
  await writeFile(bothPath, JSON.stringify({ chat: { model, channels: { signal, slack } } }));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The config file's chat settings against `fake`, with a mock model so no provider is called. */
async function chatFor(fake: { url: string }, model: MastraModelConfig = mockModel()) {
  const chat = await loadChatConfig(configPath, {
    SIGNAL_ACCOUNT: BOT_ACCOUNT,
    SIGNAL_CLI_URL: fake.url,
  });
  return { ...chat!, model };
}

function options(name: string, rest: Partial<ServerOptions>): ServerOptions {
  return { databasePath: join(directory, name, "mastra.db"), port: 0, logger: false, ...rest };
}

/** What the stopped server at `databasePath` stored: its memory threads and their messages. */
async function stored(databasePath: string) {
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

/** Resolves once the server's logger warned `message`, with that call's arguments. */
function warned(server: RunningServer, message: string) {
  const seen = Promise.withResolvers<unknown[]>();
  const logger = server.mastra.getLogger();
  const warn = logger.warn.bind(logger);
  spyOn(logger, "warn").mockImplementation((...args: Parameters<typeof logger.warn>) => {
    if (args[0] === message) seen.resolve(args);
    warn(...args);
  });
  return within(seen.promise, `the warning "${message}"`);
}

async function withFake<T>(fake: FakeSignalCli, run: (fake: FakeSignalCli) => Promise<T>) {
  try {
    return await run(fake);
  } finally {
    await fake.stop();
  }
}

test("answers an allowlisted Signal DM under resource daniel and closes the event stream on stop()", async () => {
  await withFake(fakeSignalCli(), async (fake) => {
    const settings = options("dm", { chat: await chatFor(fake) });
    const server = await startServer(settings);
    try {
      await fake.streamOpened();
      fake.receive({ aci: DANIEL, text: "hi hex" });
      const [reply] = await fake.sends(1);
      expect(reply?.params).toEqual({ account: BOT_ACCOUNT, recipient: [DANIEL], message: REPLY });
    } finally {
      // stop() lets the run finish storing before it closes the store.
      await server.stop();
    }
    expect(fake.openStreams()).toBe(0);
    const { threads, messages } = await stored(settings.databasePath);
    expect(threads.map((thread) => thread.resourceId)).toEqual([CHAT_RESOURCE_ID]);
    expect(messages.map((message) => message.role)).toEqual(["signal", "assistant"]);
  });
});

test("a stranger's Signal DM gets no reply, nothing is stored, and the log has no text", async () => {
  await withFake(fakeSignalCli(), async (fake) => {
    const settings = options("stranger", { chat: await chatFor(fake) });
    const server = await startServer(settings);
    try {
      await fake.streamOpened();
      const ignored = warned(server, IGNORED);
      fake.receive({ aci: STRANGER, number: "+15555550199", text: "secret plans" });
      const warning = await ignored;
      expect(warning).toEqual([IGNORED, { platform: "signal", sender: STRANGER }]);
      expect(JSON.stringify(warning)).not.toContain("secret plans");
    } finally {
      await server.stop();
    }
    expect(fake.calls.filter((call) => call.method === "send")).toEqual([]);
    expect((await stored(settings.databasePath)).threads).toEqual([]);
  });
});

// Mastra creates the Chat with `concurrency: { strategy: "concurrent" }` (one Chat for all
// channels), not Chat's default "drop": a message that arrives while its conversation's run is
// busy is delivered into that run, whose next model call sees it, so it is not dropped.
test("a Signal message arriving while its conversation's run is busy is answered too", async () => {
  // The answer to FIRST (model call 2) is held until SECOND has been accepted by the agent.
  const FIRST = "first message";
  const SECOND = "second message";
  const answering = Promise.withResolvers<void>();
  const secondAccepted = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const model = mockModel({
    before: async (call) => {
      prompts.push(JSON.stringify(call));
      if (prompts.length === 2) {
        answering.resolve();
        await secondAccepted.promise;
      }
    },
  });
  await withFake(fakeSignalCli(), async (fake) => {
    const settings = options("busy", { chat: await chatFor(fake, model) });
    const server = await startServer(settings);
    try {
      await fake.streamOpened();
      // The conversation exists already, as it does after Daniel's first message ever.
      fake.receive({ aci: DANIEL, text: "hello" });
      await fake.sends(1);
      const agent = server.mastra.getAgent(CHAT_AGENT_ID);
      const sendMessage = agent.sendMessage.bind(agent);
      spyOn(agent, "sendMessage").mockImplementation((...args) => {
        const sent = sendMessage(...args);
        const [input] = args;
        if (typeof input === "object" && "contents" in input && input.contents === SECOND) {
          void sent.accepted.then(() => secondAccepted.resolve());
        }
        return sent;
      });
      fake.receive({ aci: DANIEL, text: FIRST });
      await within(answering.promise, "the answer to the first message to start");
      fake.receive({ aci: DANIEL, text: SECOND });
      const [, reply] = await fake.sends(2);
      expect(reply?.params["message"]).toBe(REPLY);
    } finally {
      await server.stop();
    }
    // The run went on with one more model call that saw both messages, and answered.
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain(FIRST);
    expect(prompts[2]).toContain(SECOND);
  });
});

test("Slack and Signal share Daniel's working memory: told on Slack, known on Signal", async () => {
  const prompts: string[] = [];
  const model = toolCallingModel(
    { memory: "# User Information\n- First Name: Daniel" },
    { laterRuns: 1, before: async (call) => void prompts.push(JSON.stringify(call)) },
  );
  const slack = fakeSlack();
  try {
    await withFake(fakeSignalCli(), async (fake) => {
      const chat = await loadChatConfig(bothPath, {
        SIGNAL_ACCOUNT: BOT_ACCOUNT,
        SIGNAL_CLI_URL: fake.url,
        ...slackEnv(slack),
      });
      const settings = options("shared", { chat: { ...chat!, model } });
      const server = await startServer(settings);
      try {
        // Slack: the model stores the name in working memory (step 1), then answers (step 2).
        (await slack.connected()).send(directMessage(DANIEL_SLACK, "I'm Daniel"));
        await slack.posted();
        // Signal: a new conversation, whose first model call already sees the name.
        await fake.streamOpened();
        fake.receive({ aci: DANIEL, text: "what's my name?" });
        await fake.sends(1);
      } finally {
        await server.stop();
      }
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).not.toContain("First Name: Daniel");
      expect(prompts[2]).toContain("First Name: Daniel");
      const { threads, workingMemory } = await stored(settings.databasePath);
      expect(threads).toHaveLength(2);
      expect(threads.every((thread) => thread.resourceId === CHAT_RESOURCE_ID)).toBe(true);
      expect(workingMemory).toContain("First Name: Daniel");
    });
  } finally {
    await slack.server.stop(true);
  }
});

test("an unreachable signal-cli fails startup and leaves nothing open", async () => {
  const chat = await chatFor({ url: `http://127.0.0.1:${await freePort()}` });
  const disconnect = spyOn(chat.channels["signal"]!.adapter, "disconnect");
  const port = await freePort();
  const failed = startServer(options("unreachable", { port, chat }));
  await expect(within(failed, "the start to fail")).rejects.toThrow(/signal-cli/);
  expect(disconnect).toHaveBeenCalled();
  await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
});

test("a signal-cli that doesn't serve the bot account fails startup and opens no event stream", async () => {
  await withFake(fakeSignalCli({ accounts: [] }), async (fake) => {
    const port = await freePort();
    const failed = startServer(options("not-registered", { port, chat: await chatFor(fake) }));
    await expect(within(failed, "the start to fail")).rejects.toThrow(/not registered or linked/);
    expect(fake.paths).not.toContain("/api/v1/events");
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

/**
 * The adapter's disconnect, spied on: resolves once it has been called `count` times and every
 * call so far has finished.
 */
function disconnects(adapter: Adapter, count: number) {
  const done = Promise.withResolvers<void>();
  const disconnect = adapter.disconnect?.bind(adapter);
  if (!disconnect) throw new Error(`adapter ${adapter.name} has no disconnect()`);
  const calls: Promise<void>[] = [];
  spyOn(adapter, "disconnect").mockImplementation(() => {
    const call = disconnect();
    calls.push(call);
    if (calls.length === count) void Promise.allSettled(calls).then(() => done.resolve());
    return call;
  });
  return within(done.promise, `${count} disconnect() calls`);
}

test.each([
  ["its health check", "checkHold"],
  ["its event stream", "eventsHold"],
] as const)(
  "a signal-cli holding %s fails startup at the deadline and never opens the stream",
  async (_case, hold) => {
    const answer = Promise.withResolvers<void>();
    await withFake(fakeSignalCli({ [hold]: answer.promise }), async (fake) => {
      const chat = await chatFor(fake);
      // Once in the failed start's cleanup, once when the late start settles.
      const disconnected = disconnects(chat.channels["signal"]!.adapter, 2);
      const failed = startServer(options(`held-${hold}`, { chat, chatStartTimeoutMs: 200 }));
      await expect(within(failed, "the start to fail")).rejects.toThrow(
        "hex: chat channels did not start within 200 ms",
      );
      // signal-cli answers late: the cancelled start goes no further.
      answer.resolve();
      await disconnected;
      // A stream the fake opened after the client gave up is closed from the client's side.
      await fake.streamsClosed();
      if (hold === "checkHold") expect(fake.calls).toEqual([]);
    });
  },
);

test("stop() closes the event stream at once and bounds the wait for a running reply", async () => {
  const running = Promise.withResolvers<void>();
  // The run never finishes: the adapter's own drain would wait 10 s for it.
  const model = mockModel({
    before: () => {
      running.resolve();
      return new Promise(() => {});
    },
  });
  await withFake(fakeSignalCli(), async (fake) => {
    const server = await startServer(
      options("bounded", { chat: await chatFor(fake, model), stopGraceMs: 100 }),
    );
    await fake.streamOpened();
    fake.receive({ aci: DANIEL, text: "think hard" });
    await within(running.promise, "the run to start");
    const stopping = warned(server, "hex: stop: chat channels did not disconnect within 100 ms");
    await within(server.stop(), "stop()");
    await stopping;
    expect(fake.openStreams()).toBe(0);
  });
});
