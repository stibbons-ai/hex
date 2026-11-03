// The real Slack adapter in socket mode, built from a config file, against a fake Slack on
// loopback (Web API over HTTP plus the socket-mode WebSocket). Never reaches Slack.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import type { Server, ServerWebSocket } from "bun";
import { type RunningServer, startServer } from "../src";
import { loadChatConfig } from "../src/config";

const DANIEL = "U0DANIEL";
const REPLY = "hello from hex";

interface FakeSlack {
  server: Server<undefined>;
  connected: Promise<ServerWebSocket<undefined>>;
  closed: Promise<void>;
  posted: Promise<URLSearchParams>;
}

/** `openError` makes `apps.connections.open` fail with that Slack error code. */
function fakeSlack({ openError }: { openError?: string } = {}): FakeSlack {
  const connected = Promise.withResolvers<ServerWebSocket<undefined>>();
  const closed = Promise.withResolvers<void>();
  const posted = Promise.withResolvers<URLSearchParams>();
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bun): Promise<Response | undefined> {
      const { pathname } = new URL(request.url);
      if (pathname === "/socket") {
        return bun.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const method = pathname.replace(/^\/api\//, "");
      const body = new URLSearchParams(await request.text());
      switch (method) {
        case "apps.connections.open":
          return Response.json(
            openError
              ? { ok: false, error: openError }
              : { ok: true, url: `ws://127.0.0.1:${server.port}/socket` },
          );
        case "auth.test":
          return Response.json({
            ok: true,
            user_id: "U0BOT",
            user: "hex",
            team_id: "T0",
            bot_id: "B0",
          });
        case "users.info":
          return Response.json({
            ok: true,
            user: { id: DANIEL, name: "daniel", real_name: "Daniel" },
          });
        case "chat.postMessage":
          posted.resolve(body);
          return Response.json({ ok: true, channel: body.get("channel"), ts: "1700000001.000200" });
        default:
          return Response.json({ ok: true });
      }
    },
    websocket: {
      open(socket) {
        socket.send(
          JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A0" } }),
        );
        connected.resolve(socket);
      },
      message() {},
      close() {
        closed.resolve();
      },
    },
  });
  return {
    server,
    connected: connected.promise,
    closed: closed.promise,
    posted: posted.promise,
  };
}

function directMessage(sender: string, text: string) {
  return JSON.stringify({
    envelope_id: `envelope-${sender}`,
    type: "events_api",
    accepts_response_payload: false,
    retry_attempt: 0,
    payload: {
      type: "event_callback",
      team_id: "T0",
      event_id: `event-${sender}`,
      event: {
        type: "message",
        channel: "D0DANIEL",
        channel_type: "im",
        user: sender,
        text,
        ts: "1700000000.000100",
        event_ts: "1700000000.000100",
      },
    },
  });
}

let directory: string;
let configPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-slack-"));
  configPath = join(directory, "hex.json");
  const config = {
    chat: {
      model: "anthropic/claude-sonnet-4-5",
      channels: { slack: { options: { mode: "socket" }, allowlist: [DANIEL] } },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function chatFor(slack: FakeSlack) {
  const chat = await loadChatConfig(configPath, {
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_API_URL: `http://127.0.0.1:${slack.server.port}/api/`,
  });
  // The configured model id is real; tests swap in a mock so no provider is called.
  const model = createMockModel({ mockText: REPLY, version: "v2" }) as MastraModelConfig;
  return { ...chat!, model };
}

/**
 * Waits until the run that answered has finished: its reply stored and its run snapshot removed.
 * The run does both after posting the reply and exposes no completion signal, so this polls;
 * stopping earlier would close the store under the run (Mastra's shutdown drains only evented
 * and durable runs).
 */
async function runFinished(server: RunningServer) {
  const storage = server.mastra.getStorage()!;
  const memory = (await storage.getStore("memory"))!;
  const workflows = (await storage.getStore("workflows"))!;
  for (;;) {
    const [thread] = (await memory.listThreads({ perPage: false })).threads;
    const messages = thread ? (await memory.listMessages({ threadId: thread.id })).messages : [];
    const { total } = await workflows.listWorkflowRuns({});
    if (messages.length >= 2 && total === 0) return;
    await Bun.sleep(10);
  }
}

test("answers a Slack DM over socket mode and closes the socket on stop()", async () => {
  const slack = fakeSlack();
  try {
    const server = await startServer({
      databasePath: join(directory, "dm", "mastra.db"),
      port: 0,
      logger: false,
      chat: await chatFor(slack),
    });
    try {
      const socket = await slack.connected;
      socket.send(directMessage(DANIEL, "hi hex"));
      const reply = await slack.posted;
      expect(reply.get("channel")).toBe("D0DANIEL");
      expect(reply.get("markdown_text")).toBe(REPLY);
      expect(reply.get("token")).toBe("xoxb-test");
      await runFinished(server);
    } finally {
      await server.stop();
    }
    await slack.closed;
  } finally {
    await slack.server.stop(true);
  }
});

test("a Slack socket that cannot connect fails startup", async () => {
  const slack = fakeSlack({ openError: "invalid_auth" });
  try {
    const failed = startServer({
      databasePath: join(directory, "invalid-auth", "mastra.db"),
      port: 0,
      logger: false,
      chat: await chatFor(slack),
    });
    await expect(failed).rejects.toThrow(/invalid_auth/);
  } finally {
    await slack.server.stop(true);
  }
});
