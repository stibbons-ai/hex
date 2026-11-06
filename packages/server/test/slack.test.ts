// The real Slack adapter in socket mode, built from a config file, against a fake Slack on
// loopback (Web API over HTTP plus the socket-mode WebSocket). Never reaches Slack.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { startServer } from "../src";
import type { ServerOptions } from "../src";
import { loadChatConfig } from "../src/channels";
import type { ChatConfig } from "../src/channels";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import { MainChannel, mainChannelLayer } from "../src/main-channel";
import { buildEml, pdfMail } from "./eml";
import {
  DANIEL,
  DM_CHANNEL,
  type FakeSlack,
  directMessage,
  fakeSlack,
  slackEnv,
} from "./fake-slack";
import { memoryMailbox } from "./memory-mailbox";
import { REPLY, mockModel } from "./mock-model";
import { scriptedDateExtractor } from "./scripted-extractor";
import { serverOptions } from "./server-helpers";
import { freePort, within } from "./timeouts";

let directory: string;
let configPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-slack-"));
  configPath = join(directory, "hex.json");
  const config = {
    chat: {
      model: "anthropic/claude-opus-5-5",
      channels: { slack: { options: { mode: "socket" }, allowlist: [DANIEL] } },
      mainChannel: { channel: "slack", user: DANIEL },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function chatFor(slack: FakeSlack) {
  const chat = await loadChatConfig(configPath, slackEnv(slack));
  // The configured model id is real; tests swap in a mock so no provider is called.
  return { ...chat!, model: mockModel() };
}

function options(name: string, rest: Partial<ServerOptions>): ServerOptions {
  return serverOptions(directory, name, rest);
}

test("answers a Slack DM over socket mode and closes the socket on stop()", async () => {
  const slack = fakeSlack();
  try {
    const server = await startServer(options("dm", { chat: await chatFor(slack) }));
    try {
      const socket = await slack.connected();
      socket.send(directMessage(DANIEL, "hi hex"));
      const reply = await slack.posted();
      expect(reply.get("channel")).toBe(DM_CHANNEL);
      expect(reply.get("markdown_text")).toBe(REPLY);
      expect(reply.get("token")).toBe("xoxb-test");
    } finally {
      await server.stop();
    }
    await slack.closed();
    // Typing status is off: no assistant-thread status calls.
    expect(slack.methods).not.toContain("assistant.threads.setStatus");
  } finally {
    await slack.server.stop(true);
  }
});

test("a Slack socket that cannot connect fails startup and leaves nothing open", async () => {
  const slack = fakeSlack({ openError: "invalid_auth" });
  try {
    const chat = await chatFor(slack);
    const disconnect = spyOn(chat.channels["slack"]!.adapter, "disconnect");
    const port = await freePort();
    const failed = startServer(options("invalid-auth", { port, chat }));
    await expect(within(failed, "the start to fail")).rejects.toThrow(/invalid_auth/);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  } finally {
    await slack.server.stop(true);
  }
});

test("a bot token Slack rejects fails startup, naming the variable, and closes the socket", async () => {
  const slack = fakeSlack({ authError: "invalid_auth" });
  try {
    const port = await freePort();
    const failed = startServer(options("bad-bot-token", { port, chat: await chatFor(slack) }));
    await expect(within(failed, "the start to fail")).rejects.toThrow(
      'chat channel "slack": Slack did not accept SLACK_BOT_TOKEN',
    );
    await expect(failed).rejects.not.toThrow("xoxb-test");
    await slack.closed();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  } finally {
    await slack.server.stop(true);
  }
});

test("a Slack socket that keeps retrying fails startup at the deadline and is shut down", async () => {
  // Slack's socket client retries a non-fatal error like this one without end.
  const slack = fakeSlack({ openError: "internal_error" });
  try {
    const chat = await chatFor(slack);
    const disconnect = spyOn(chat.channels["slack"]!.adapter, "disconnect");
    const port = await freePort();
    const failed = startServer(options("retrying", { port, chat, chatStartTimeoutMs: 200 }));
    await expect(within(failed, "the start to fail")).rejects.toThrow(
      "hex: chat channels did not start within 200 ms",
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  } finally {
    await slack.server.stop(true);
  }
});

test("a Slack start that finishes after the deadline leaves no socket open", async () => {
  const authAnswer = Promise.withResolvers<void>();
  const slack = fakeSlack({ authHold: authAnswer.promise });
  try {
    const failed = startServer(
      options("late-auth", { chat: await chatFor(slack), chatStartTimeoutMs: 200 }),
    );
    await expect(within(failed, "the start to fail")).rejects.toThrow(
      "hex: chat channels did not start within 200 ms",
    );
    // Slack answers late: the start goes on, opens the socket, and hex closes it again.
    authAnswer.resolve();
    await slack.connected();
    await slack.closed();
  } finally {
    await slack.server.stop(true);
  }
});

/** Posts `text` to the Main channel configured for `chat`, as the Intake workflow does. */
const postToMain = (chat: ChatConfig, text: string, layer = mainChannelLayer(chat.mainChannel!)) =>
  Effect.runPromise(MainChannel.use((channel) => channel.post(text)).pipe(Effect.provide(layer)));

test("the Main channel opens Daniel's DM and posts there unprompted, quoted text kept literal", async () => {
  const slack = fakeSlack();
  try {
    const chat = await chatFor(slack);
    const server = await startServer(options("main-channel", { chat }));
    try {
      await slack.connected();
      // No inbound message: hex speaks first.
      const text = "Intake processed: `<!channel> & <@U0X> @here https://evil.example`";
      expect(await postToMain(chat, text)).toBe("sent");
      const post = await slack.posted();
      expect(slack.opened).toEqual([DANIEL]);
      expect(post.get("channel")).toBe(DM_CHANNEL);
      // Plain `text` with Slack's escapes, not `markdown_text`: no mention or link forms.
      expect(post.get("text")).toBe(
        "Intake processed: `&lt;!channel&gt; &amp; &lt;@U0X&gt; @here https://evil.example`",
      );
      expect(post.has("markdown_text")).toBe(false);
      expect(post.get("unfurl_links")).toBe("false");
    } finally {
      await server.stop();
    }
  } finally {
    await slack.server.stop(true);
  }
});

test("the Main channel opens Daniel's DM once and posts every later report there", async () => {
  const slack = fakeSlack();
  try {
    const chat = await chatFor(slack);
    const server = await startServer(options("main-channel-twice", { chat }));
    try {
      await slack.connected();
      const layer = mainChannelLayer(chat.mainChannel!);
      expect(await postToMain(chat, "first", layer)).toBe("sent");
      expect(await postToMain(chat, "second", layer)).toBe("sent");
      expect(slack.opened).toEqual([DANIEL]);
      expect(slack.methods.filter((method) => method === "chat.postMessage")).toHaveLength(2);
    } finally {
      await server.stop();
    }
  } finally {
    await slack.server.stop(true);
  }
});

test("a post Slack refuses fails with a MainChannelError naming Slack's error", async () => {
  const slack = fakeSlack({ postError: "channel_not_found" });
  try {
    const chat = await chatFor(slack);
    const server = await startServer(options("main-channel-refused", { chat }));
    try {
      await slack.connected();
      const failed = await postToMain(chat, "Intake processed: `x`").catch(
        (error: unknown) => error,
      );
      expect(failed).toMatchObject({
        _tag: "MainChannelError",
        message: expect.stringMatching(/^posting to slack failed: .*channel_not_found/),
      });
    } finally {
      await server.stop();
    }
  } finally {
    await slack.server.stop(true);
  }
});

test("the mailbox watcher processes an Intake and its Intake report arrives in Daniel's Slack DM", async () => {
  const slack = fakeSlack();
  try {
    const chat = await chatFor(slack);
    const server = options("watcher-report", { chat });
    const paths = {
      databasePath: server.databasePath,
      outboxDirectory: join(directory, "watcher-report", "outbox"),
    };
    const mailbox = memoryMailbox();
    mailbox.deliver(buildEml(pdfMail("slack-report@shop.example")));
    const runtime = createIntakeRuntime(paths, {
      dateExtractor: scriptedDateExtractor(() => ({ year: 2026, month: 10, day: 1 })).layer,
      mailbox: mailbox.layer,
      mainChannel: mainChannelLayer(chat.mainChannel!),
    });
    const running = await startServer({
      ...server,
      workflows: { [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category: "ER" }) },
      mailbox: { runtime, pollMs: 60_000 },
    });
    try {
      const post = await slack.posted();
      expect(post.get("channel")).toBe(DM_CHANNEL);
      expect(post.get("text")).toBe(
        "Intake processed: `Rechnung` from `billing@shop.example`\n1 Document filed under 2026-10/ER",
      );
      await within(mailbox.waiting(), "the watcher's look");
      expect(mailbox.messageIds("hex/processed")).toEqual(["slack-report@shop.example"]);
    } finally {
      await running.stop();
      await runtime.dispose();
    }
  } finally {
    await slack.server.stop(true);
  }
});
