// A fake Slack on loopback: the Web API over HTTP plus the socket-mode WebSocket.
import type { Server, ServerWebSocket } from "bun";
import { within } from "./timeouts";

export const DANIEL = "U0DANIEL";

export interface FakeSlack {
  server: Server<undefined>;
  /** Web API methods called, in order. */
  methods: string[];
  /** The users each `conversations.open` opened a DM with, in order. */
  opened: string[];
  /** Each waits at most 2 s. */
  connected(): Promise<ServerWebSocket<undefined>>;
  closed(): Promise<void>;
  posted(): Promise<URLSearchParams>;
}

export interface FakeSlackOptions {
  /** Makes `apps.connections.open` fail with this Slack error code. */
  openError?: string;
  /** Makes `auth.test` fail with this Slack error code (the bot token is rejected). */
  authError?: string;
  /** `auth.test` answers only once this settles (a slow Slack). */
  authHold?: Promise<void>;
  /** Makes `chat.postMessage` fail with this Slack error code. */
  postError?: string;
}

/** Daniel's DM with hex: where his messages come from, and what `conversations.open` answers. */
export const DM_CHANNEL = "D0DANIEL";

export function fakeSlack({
  openError,
  authError,
  authHold,
  postError,
}: FakeSlackOptions = {}): FakeSlack {
  const connected = Promise.withResolvers<ServerWebSocket<undefined>>();
  const closed = Promise.withResolvers<void>();
  const posted = Promise.withResolvers<URLSearchParams>();
  const methods: string[] = [];
  const opened: string[] = [];
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
      methods.push(method);
      switch (method) {
        case "apps.connections.open":
          return Response.json(
            openError
              ? { ok: false, error: openError }
              : { ok: true, url: `ws://127.0.0.1:${server.port}/socket` },
          );
        case "auth.test":
          await authHold;
          return Response.json(
            authError
              ? { ok: false, error: authError }
              : { ok: true, user_id: "U0BOT", user: "hex", team_id: "T0", bot_id: "B0" },
          );
        case "users.info":
          return Response.json({
            ok: true,
            user: { id: DANIEL, name: "daniel", real_name: "Daniel" },
          });
        case "conversations.open":
          opened.push(body.get("users") ?? "");
          return Response.json({ ok: true, channel: { id: DM_CHANNEL } });
        case "chat.postMessage":
          if (postError) return Response.json({ ok: false, error: postError });
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
    methods,
    opened,
    connected: () => within(connected.promise, "the Slack socket to open"),
    closed: () => within(closed.promise, "the Slack socket to close"),
    posted: () => within(posted.promise, "a chat.postMessage call"),
  };
}

/** Slack's variables for a config whose `slack` channel talks to `slack`. */
export function slackEnv(slack: FakeSlack) {
  return {
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_API_URL: `http://127.0.0.1:${slack.server.port}/api/`,
  };
}

/** A DM reply inside a thread (`thread_ts` set), where Slack's typing status would apply. */
export function directMessage(sender: string, text: string) {
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
        channel: DM_CHANNEL,
        channel_type: "im",
        user: sender,
        text,
        ts: "1700000000.000100",
        event_ts: "1700000000.000100",
        thread_ts: "1699999999.000100",
      },
    },
  });
}
