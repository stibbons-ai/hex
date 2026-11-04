// The real Slack adapter in socket mode, built from a config file, against a fake Slack on
// loopback (Web API over HTTP plus the socket-mode WebSocket). Never reaches Slack.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src";
import type { ServerOptions } from "../src";
import { loadChatConfig } from "../src/config";
import { DANIEL, type FakeSlack, directMessage, fakeSlack, slackEnv } from "./fake-slack";
import { REPLY, mockModel } from "./mock-model";
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
      expect(reply.get("channel")).toBe("D0DANIEL");
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
