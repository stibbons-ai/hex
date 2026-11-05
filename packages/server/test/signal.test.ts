// The real Signal adapter over signal-cli's HTTP transport, built from a config file, against a
// fake signal-cli on loopback (JSON-RPC plus the server-sent receive events). Never reaches
// Signal, Slack or a model provider.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkError } from "@chat-adapter/shared";
import type { MastraModelConfig } from "@mastra/core/llm";
import { ConsoleLogger } from "@mastra/core/logger";
import type { Adapter } from "chat";
import { type ServerOptions, startServer } from "../src";
import { CHAT_AGENT_ID, CHAT_RESOURCE_ID } from "../src/chat";
import { loadChatConfig } from "../src/config";
import {
  BOT_ACCOUNT,
  DANIEL,
  type FakeSignalCli,
  GROUP_ID,
  fakeSignalCli,
} from "./fake-signal-cli";
import { DANIEL as DANIEL_SLACK, directMessage, fakeSlack, slackEnv } from "./fake-slack";
import { REPLY, heldModel, mockModel, toolCallingModel } from "./mock-model";
import { serverOptions, stored, warnings } from "./server-helpers";
import { freePort, within } from "./timeouts";

const STRANGER = "5e5e5e5e-0000-4000-8000-00000000057a";
const IGNORED = "hex: ignored message from a sender not on the allowlist";
const NOT_DIRECT = "hex: ignored message outside a direct message";
/** A daemon serving several accounts (`listAccounts`), and one started with `-a <account>`. */
const DAEMONS = [
  ["a multi-account daemon", false],
  ["a single-account daemon (-a)", true],
] as const;

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
  return serverOptions(directory, name, rest);
}

async function withFake<T>(fake: FakeSignalCli, run: (fake: FakeSignalCli) => Promise<T>) {
  try {
    return await run(fake);
  } finally {
    await fake.stop();
  }
}

const sent = (fake: FakeSignalCli) =>
  fake.calls.filter((call) => call.method === "send").map((call) => call.params["message"]);

test.each(DAEMONS)(
  "on %s, answers an allowlisted Signal DM under resource daniel and closes the stream on stop()",
  async (name, singleAccount) => {
    await withFake(fakeSignalCli({ singleAccount }), async (fake) => {
      const settings = options(`dm-${singleAccount}`, { chat: await chatFor(fake) });
      const server = await startServer(settings);
      try {
        await fake.streamOpened();
        fake.receive({ aci: DANIEL, text: "hi hex" });
        const [reply] = await fake.sends(1);
        expect(reply?.params).toEqual({
          account: BOT_ACCOUNT,
          recipient: [DANIEL],
          message: REPLY,
        });
      } finally {
        // stop() lets the run finish storing before it closes the store.
        await server.stop();
      }
      await fake.streamsClosed();
      // How the adapter found the bot account: a -a daemon doesn't implement listAccounts, so
      // the account's own contact entry is asked for instead.
      const ownContact = { recipient: [BOT_ACCOUNT], allRecipients: true };
      const lookups = fake.calls.filter(
        ({ method, params }) =>
          method === "listAccounts" ||
          (method === "listContacts" && JSON.stringify(params) === JSON.stringify(ownContact)),
      );
      expect(lookups).toEqual(
        singleAccount
          ? [
              { method: "listAccounts", params: {}, error: -32601 },
              { method: "listContacts", params: ownContact },
            ]
          : [{ method: "listAccounts", params: {} }],
      );
      const { threads, messages } = await stored(settings.databasePath);
      expect(
        threads.map((thread) => thread.resourceId),
        name,
      ).toEqual([CHAT_RESOURCE_ID]);
      expect(messages.map((message) => message.role)).toEqual(["signal", "assistant"]);
    });
  },
);

test("a stranger's Signal DM gets no reply, nothing is persisted, and the log has no text", async () => {
  await withFake(fakeSignalCli(), async (fake) => {
    const settings = options("stranger", { chat: await chatFor(fake) });
    const server = await startServer(settings);
    try {
      await fake.streamOpened();
      const ignored = warnings(server, IGNORED);
      fake.receive({ aci: STRANGER, number: "+15555550199", text: "secret plans" });
      const [warning] = await ignored;
      expect(warning).toEqual([IGNORED, { platform: "signal", sender: STRANGER }]);
      expect(JSON.stringify(warning)).not.toContain("secret plans");
    } finally {
      await server.stop();
    }
    expect(sent(fake)).toEqual([]);
    expect((await stored(settings.databasePath)).threads).toEqual([]);
  });
});

test("Daniel's Signal Group messages, an @mention of hex included, are ignored", async () => {
  await withFake(fakeSignalCli(), async (fake) => {
    const settings = options("group", { chat: await chatFor(fake) });
    const server = await startServer(settings);
    try {
      await fake.streamOpened();
      const ignored = warnings(server, NOT_DIRECT);
      // An @mention would make Mastra subscribe to the Group and answer it there.
      fake.receive({ aci: DANIEL, text: "what's in my working memory?", group: { mention: true } });
      const [line] = await ignored;
      expect(line).toEqual([NOT_DIRECT, { platform: "signal", sender: DANIEL }]);
      expect(JSON.stringify(line)).not.toContain("working memory");
      // Unsubscribed, a plain Group message reaches no handler at all; subscribed, it would be
      // answered. The DM after it is dispatched after it, and stop() waits for both.
      fake.receive({ aci: DANIEL, text: "and now?", group: { mention: false } });
      fake.receive({ aci: DANIEL, text: "hi hex" });
      await fake.sends(1);
    } finally {
      await server.stop();
    }
    expect(fake.calls.filter((call) => call.method === "send").map((call) => call.params)).toEqual([
      { account: BOT_ACCOUNT, recipient: [DANIEL], message: REPLY },
    ]);
    // Only the DM has a memory thread, so the Group has no subscription either (Mastra keeps
    // that in the thread's metadata).
    const { threads } = await stored(settings.databasePath);
    expect(threads.map((thread) => thread.metadata?.["channel_externalThreadId"])).toEqual([
      `signal:dm:${DANIEL}`,
    ]);
  });
});

test("a Group hex is still subscribed to (as after a restart) gets no answer either", async () => {
  await withFake(fakeSignalCli(), async (fake) => {
    const settings = options("subscribed-group", { chat: await chatFor(fake) });
    const server = await startServer(settings);
    try {
      // The memory thread Mastra keeps for a subscribed conversation, as an earlier @mention
      // (before Signal was DM-only) would have left it.
      const store = await server.mastra.getStorage()?.getStore("memory");
      const now = new Date();
      await store?.saveThread({
        thread: {
          id: "group-thread",
          resourceId: CHAT_RESOURCE_ID,
          title: "",
          createdAt: now,
          updatedAt: now,
          metadata: {
            channel_platform: "signal",
            channel_externalThreadId: `signal:group:${Buffer.from(GROUP_ID, "base64").toString("base64url")}`,
            channel_ownerId: CHAT_AGENT_ID,
            channel_subscribed: "true",
          },
        },
      });
      await fake.streamOpened();
      const ignored = warnings(server, NOT_DIRECT, 2);
      // A plain Group message from Daniel reaches the subscribed-message handler; a stranger's
      // @mention the mention handler.
      fake.receive({ aci: DANIEL, text: "secret plans", group: { mention: false } });
      fake.receive({ aci: STRANGER, text: "leak it", group: { mention: true } });
      // Both are checked by the guard; the test doesn't rely on which comes first.
      const lines = await ignored;
      expect(lines).toHaveLength(2);
      expect(lines).toContainEqual([NOT_DIRECT, { platform: "signal", sender: DANIEL }]);
      expect(lines).toContainEqual([NOT_DIRECT, { platform: "signal", sender: STRANGER }]);
      expect(JSON.stringify(lines)).not.toMatch(/secret plans|leak it/);
    } finally {
      await server.stop();
    }
    expect(sent(fake)).toEqual([]);
    expect((await stored(settings.databasePath)).messages).toEqual([]);
  });
});

// hex sets the Chat SDK's "queue" strategy (one Chat for all channels): a message that arrives
// while its conversation's run is busy waits its turn, then gets its own run and answer.
test("a Signal message arriving while its conversation's run is busy is answered after it", async () => {
  // Model call 2 (the answer to FIRST) is held until SECOND has been queued.
  const FIRST = "first message";
  const SECOND = "second message";
  const { model, prompts, busy, release } = heldModel(2);
  await withFake(fakeSignalCli(), async (fake) => {
    const settings = options("busy", { chat: await chatFor(fake, model) });
    const server = await startServer(settings);
    try {
      await fake.streamOpened();
      // The conversation exists already, as it does after Daniel's first message ever.
      fake.receive({ aci: DANIEL, text: "hello" });
      await fake.sends(1);
      const state = server.mastra.getAgent(CHAT_AGENT_ID).getChannels()?.sdk?.getState();
      if (!state) throw new Error("no chat state");
      const enqueue = state.enqueue.bind(state);
      spyOn(state, "enqueue").mockImplementation(async (...args) => {
        const depth = await enqueue(...args);
        release();
        return depth;
      });
      fake.receive({ aci: DANIEL, text: FIRST });
      await within(busy, "the answer to the first message to start");
      fake.receive({ aci: DANIEL, text: SECOND });
      await fake.sends(3);
    } finally {
      await server.stop();
    }
    // Call 2 answered FIRST alone; call 3 answered SECOND, with FIRST's exchange as history.
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(FIRST);
    expect(prompts[1]).not.toContain(SECOND);
    expect(prompts[2]).toContain(FIRST);
    expect(prompts[2]).toContain(SECOND);
    expect(sent(fake)).toEqual(["reply 1", "reply 2", "reply 3"]);
    const { threads, messages } = await stored(settings.databasePath);
    expect(threads).toHaveLength(1);
    expect(messages.map((message) => message.role)).toEqual([
      "signal",
      "assistant",
      "signal",
      "assistant",
      "signal",
      "assistant",
    ]);
    const said = JSON.stringify(messages);
    expect(said).toContain(FIRST);
    expect(said).toContain(SECOND);
  });
});

test("Slack and Signal share Daniel's working memory: told on Slack, known on Signal", async () => {
  const prompts: string[] = [];
  const model = toolCallingModel(
    { memory: "# User Information\n- First Name: Daniel" },
    { laterCalls: 1, before: async (call) => void prompts.push(JSON.stringify(call)) },
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

/**
 * Starts a server against `fake` with `account` as SIGNAL_ACCOUNT and expects the start to fail.
 * Returns the error and everything printed or logged meanwhile: console output and the Mastra
 * logger's calls, all as one inspected string.
 */
async function failedStart(fake: FakeSignalCli, account: string, name: string) {
  const port = await freePort();
  const printed: unknown[] = [];
  const logger = new ConsoleLogger({ level: "debug" });
  const spies = [
    ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args) => void printed.push(args)),
    ),
    ...(["debug", "info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation((...args) => void printed.push(args)),
    ),
  ];
  try {
    const chat = await loadChatConfig(configPath, {
      SIGNAL_ACCOUNT: account,
      SIGNAL_CLI_URL: fake.url,
    });
    const starting = startServer(
      options(name, { port, logger, chat: { ...chat!, model: mockModel() } }),
    );
    const failure = await within(starting, "the start to fail").then(
      () => {
        throw new Error("the start did not fail");
      },
      (error: unknown) => error,
    );
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    return {
      failure,
      output: `${String(failure)} ${(failure as Error).stack} ${Bun.inspect(failure)} ${Bun.inspect(printed)}`,
    };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** The forms the bot account can take in an error: as configured, lowercased, URL-encoded. */
const forms = (account: string) => [account, account.toLowerCase(), encodeURIComponent(account)];

test.each(DAEMONS)(
  "%s that doesn't serve the bot account fails startup without naming the account",
  async (_name, singleAccount) => {
    await withFake(fakeSignalCli({ accounts: [], singleAccount }), async (fake) => {
      const { failure, output } = await failedStart(fake, BOT_ACCOUNT, `unserved-${singleAccount}`);
      expect(String(failure)).toMatch(/not registered or linked/);
      expect(String(failure)).toContain("SIGNAL_ACCOUNT");
      for (const form of forms(BOT_ACCOUNT)) expect(output).not.toContain(form);
      expect(fake.paths).not.toContain("/api/v1/events");
    });
  },
);

test("a bot account given as an uppercase ACI is redacted as the adapter normalises it", async () => {
  // Hex letters, so the adapter's lowercase form differs from the configured one.
  const account = "ABCDEF01-0000-4000-8000-00000000000B";
  expect(account).not.toBe(account.toLowerCase());
  await withFake(fakeSignalCli({ accounts: [] }), async (fake) => {
    const { failure, output } = await failedStart(fake, account, "unserved-aci");
    expect(String(failure)).toMatch(/not registered or linked/);
    for (const form of forms(account)) expect(output).not.toContain(form);
  });
});

test("an event stream signal-cli drops at once fails startup without naming the account", async () => {
  // The adapter's error carries Bun's fetch error, whose `path` has `?account=<URL-encoded>`.
  await withFake(fakeSignalCli({ eventsReset: true }), async (fake) => {
    const { failure, output } = await failedStart(fake, BOT_ACCOUNT, "events-reset");
    expect(fake.paths).toContain("/api/v1/events");
    for (const form of forms(BOT_ACCOUNT)) expect(output).not.toContain(form);
    // Still the adapter's error, as code that checks its class or code expects.
    expect(failure).toBeInstanceOf(NetworkError);
    expect(failure).toMatchObject({ code: "NETWORK_ERROR", adapter: "signal" });
    expect(Error.isError(failure)).toBe(true);
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
  "a signal-cli holding %s fails startup at the deadline and closes any stream it opened late",
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
      if (hold === "checkHold") {
        expect(fake.calls).toEqual([]);
      } else {
        // The start got as far as the stream; the fake opens it late, the client closes it.
        expect(fake.paths).toContain("/api/v1/events");
        await fake.streamOpened();
        await fake.streamsClosed();
        expect(fake.streamsOpenedEver()).toBe(1);
      }
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
    const stopping = warnings(server, "hex: stop: chat channels did not disconnect within 100 ms");
    await within(server.stop(), "stop()");
    await stopping;
    await fake.streamsClosed();
  });
});
